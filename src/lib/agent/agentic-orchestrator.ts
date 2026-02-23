import { embedMany, generateObject, generateText, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";

import { getServerEnv } from "@/lib/env";
import { agentSystemPrompt, buildAgentRuntimePrompt, type AgentRequestMode } from "@/lib/agent/prompts";
import { rerankerSchema, type RerankerOutput } from "@/lib/agent/schemas";
import { createSearchTools, type PreliminaryResult, type SearchAgentState } from "@/lib/agent/tools";
import { getCompaniesByIds } from "@/lib/search/rpc";
import { insertSearchRun, insertSearchRunResults, insertSearchRunStep, updateSearchRun } from "@/lib/search/telemetry";
import type { FinalAnswerPayload } from "@/lib/search/types";
import { SEARCH_UNAVAILABLE_MESSAGE } from "@/lib/search/user-facing-errors";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import type { AgentActivityEventPayload, ChatMessage, ClarificationOption } from "@/types/chat";
import type { Company } from "@/types/company";

export interface AgentOrchestratorInput {
  messages: ChatMessage[];
  clientContext: {
    previousCandidateIds: string[];
  };
  sessionId: string;
  onActivity?: (event: AgentActivityEventPayload) => Promise<void> | void;
  onPartialText?: (value: string) => Promise<void> | void;
  onClarificationRequest?: (data: { question: string; options: ClarificationOption[] }) => void;
}

interface PendingClarification {
  sessionId: string;
  state: SearchAgentState;
  messages: ChatMessage[];
  runId: string;
  telemetryEnabled: boolean;
  startedAtMs: number;
  runtimePrompt: string;
  requestMode: AgentRequestMode;
  targetResultCount: number;
  previousCandidateIds: string[];
}

// In-memory store for pending clarifications (in production, use Redis or similar)
const pendingClarifications = new Map<string, PendingClarification>();

// Clean up expired clarifications every 5 minutes
const CLARIFICATION_TIMEOUT_MS = 5 * 60 * 1000;

function cleanupExpiredClarifications(): void {
  const now = Date.now();
  for (const [sessionId, pending] of pendingClarifications.entries()) {
    if (now - pending.startedAtMs > CLARIFICATION_TIMEOUT_MS) {
      pendingClarifications.delete(sessionId);
    }
  }
}

// Only set up interval in a Node.js environment
if (typeof setInterval !== "undefined") {
  setInterval(cleanupExpiredClarifications, 60_000);
}

const MAX_STEPS = 15;
const MAX_RUNTIME_MS = 240_000;
const DEFAULT_TARGET_RESULT_COUNT = 15;
const MAX_TARGET_RESULT_COUNT = 50;
const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  single: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
};

function dedupeCompanyIds(companyIds: string[]): string[] {
  return Array.from(new Set(companyIds.filter(Boolean)));
}

function inferRequestMode(userMessage: string, hasPreviousCandidates: boolean): AgentRequestMode {
  const normalized = userMessage.toLowerCase();
  const isMoreRequest = /\b(more|additional|another|show more|next page|more results)\b/.test(normalized);
  const isFilterRequest = /\b(filter|narrow|refine|which of these|from those|from these|among these|only these|only those)\b/.test(normalized);
  const isSimilarityRequest = /\b(similar|like|alternatives?|competitors?|vs|versus|comparable)\b/.test(normalized);

  if (hasPreviousCandidates && isMoreRequest) {
    return "more";
  }
  if (hasPreviousCandidates && isFilterRequest) {
    return "filter";
  }
  if (isSimilarityRequest) {
    return "similar";
  }
  return "new";
}

function clampResultCount(value: number): number {
  return Math.min(MAX_TARGET_RESULT_COUNT, Math.max(1, value));
}

function parseCountToken(token: string): number | null {
  const trimmed = token.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  if (/^\d{1,3}$/.test(trimmed)) {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? clampResultCount(parsed) : null;
  }

  const normalized = trimmed.replace(/-/g, " ").replace(/\s+/g, " ");
  if (NUMBER_WORDS[normalized]) {
    return clampResultCount(NUMBER_WORDS[normalized]);
  }

  const parts = normalized.split(" ");
  if (parts.length === 2 && NUMBER_WORDS[parts[0]] && NUMBER_WORDS[parts[1]]) {
    const combined = NUMBER_WORDS[parts[0]] + NUMBER_WORDS[parts[1]];
    return clampResultCount(combined);
  }

  return null;
}

function extractTargetResultCount(userMessage: string, requestMode: AgentRequestMode, previousCount: number): number {
  const explicitCountWithEntity = userMessage.match(
    /\b(?:only|just|exactly|around|about|roughly|up to|at most|at least|top|show|find|give|list|return|want)?\s*((?:\d{1,3}|[a-z]+(?:[-\s][a-z]+)?))\s+(?:results?|companies|startups?)\b/i
  );
  if (explicitCountWithEntity?.[1]) {
    const parsed = parseCountToken(explicitCountWithEntity[1]);
    if (parsed !== null) {
      return parsed;
    }
  }

  const singularEntityIntent = userMessage.match(/\b(?:only|just|exactly)?\s*(?:a|an|single)\s+(?:result|company|startup)\b/i);
  if (singularEntityIntent) {
    return 1;
  }

  if (requestMode === "more" && previousCount > 0) {
    return clampResultCount(Math.max(DEFAULT_TARGET_RESULT_COUNT, previousCount));
  }

  return DEFAULT_TARGET_RESULT_COUNT;
}

function shouldClarifyBeforeSearch(userMessage: string, requestMode: AgentRequestMode): boolean {
  if (requestMode === "more" || requestMode === "filter" || requestMode === "similar") {
    return false;
  }

  const normalized = userMessage.trim().toLowerCase();
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  const broadPattern = /\b(ai agents?|ai assistants?|automation tools?|ai companies?|startups?)\b/.test(normalized);
  const lacksConstraint = !/\b(for|in|with|about|that|where|focused|for developers|for sales|for healthcare|for fintech)\b/.test(normalized);

  return wordCount <= 3 || (broadPattern && lacksConstraint);
}

function buildAgentSystemMessage(runtimePrompt: string): string {
  return `${agentSystemPrompt}\n\n${runtimePrompt}`;
}

const rerankerSystemPrompt = `You are ranking company search candidates for a user query.
Return strictly valid JSON.

Your job is to:
1. Re-rank the candidates based on how well they match the user's likely intent
2. Assign confidence scores (0-1) to each
3. Provide brief reasons explaining why each company matches

Prioritize:
- Companies that ARE what the user is looking for (not just mentioning keywords)
- Strong matches in niches field (curated capability descriptions)
- Relevance of product_description and problem_solved to user query

Return the rankedCompanyIds in order from most to least relevant.`;

function buildRerankerPrompt(input: {
  userMessage: string;
  candidates: PreliminaryResult[];
  companyDetails: Company[];
  targetResultCount: number;
}): string {
  const companyMap = new Map(input.companyDetails.map((c) => [c.id, c]));
  const candidateLimit = Math.min(80, Math.max(24, input.targetResultCount * 3));

  const candidateBlock = input.candidates
    .slice(0, candidateLimit)
    .map((candidate) => {
      const company = companyMap.get(candidate.companyId);
      return JSON.stringify({
        companyId: candidate.companyId,
        companyName: company?.company_name ?? "Unknown",
        preliminaryConfidence: candidate.confidence,
        preliminaryReason: candidate.reason,
        description: company?.description?.slice(0, 300) ?? "",
        productDescription: company?.product_description?.slice(0, 300) ?? "",
        niches: company?.niches?.slice(0, 6) ?? [],
        sectors: company?.sectors ?? [],
        categories: company?.categories ?? [],
      });
    })
    .join("\n");

  return [
    `User query: ${input.userMessage}`,
    `Target result count: ${input.targetResultCount}`,
    "",
    "Candidates to rerank:",
    candidateBlock,
    "",
    "Return JSON: { confidence, rankedCompanyIds, perCompany: [{companyId, reason, inlineDescription, evidenceChips, confidence}] }",
  ].join("\n");
}

function formatToolLabel(toolName: string): string {
  const labels: Record<string, string> = {
    search_exact_name: "Searching by name",
    search_semantic: "Semantic search",
    search_keyword: "Keyword search",
    search_taxonomy: "Taxonomy filter",
    get_company_details: "Getting company details",
    clarify_with_user: "Asking for clarification",
    finalize_search: "Finalizing results",
  };
  return labels[toolName] ?? toolName;
}

function formatToolDetail(toolName: string, input: unknown): string {
  const args = input as Record<string, unknown>;
  switch (toolName) {
    case "search_exact_name":
      return `Looking for "${args.companyName}"`;
    case "search_semantic":
      return `Query: "${args.query}"`;
    case "search_keyword":
      return `Keywords: "${args.keywords}"`;
    case "search_taxonomy": {
      const parts: string[] = [];
      if (args.sectors) parts.push(`sectors: ${(args.sectors as string[]).join(", ")}`);
      if (args.categories) parts.push(`categories: ${(args.categories as string[]).join(", ")}`);
      if (args.businessModels) parts.push(`models: ${(args.businessModels as string[]).join(", ")}`);
      return parts.join("; ") || "Filtering by taxonomy";
    }
    case "get_company_details":
      return `${(args.companyIds as string[]).length} companies`;
    case "clarify_with_user":
      return `"${args.question}"`;
    case "finalize_search":
      return `${(args.rankedResults as unknown[]).length} results`;
    default:
      return "";
  }
}

function summarizeToolOutput(toolName: string, result: unknown): Record<string, unknown> {
  const data = result as Record<string, unknown>;
  switch (toolName) {
    case "search_exact_name":
    case "search_keyword":
      return {
        totalFound: data.totalFound,
        resultCount: Array.isArray(data.results) ? data.results.length : 0,
        topIds: Array.isArray(data.results)
          ? (data.results as Array<{ companyId: string }>).slice(0, 5).map((r) => r.companyId)
          : [],
      };
    case "search_semantic":
      return {
        totalFound: data.totalFound,
        resultCount: Array.isArray(data.results) ? data.results.length : 0,
        topIds: Array.isArray(data.results)
          ? (data.results as Array<{ companyId: string }>).slice(0, 5).map((r) => r.companyId)
          : [],
        embeddingDurationMs: data.embeddingDurationMs,
      };
    case "search_taxonomy":
      return {
        totalFound: data.totalFound,
        resultCount: Array.isArray(data.results) ? data.results.length : 0,
      };
    case "get_company_details":
      return {
        companyCount: Array.isArray(data.companies) ? data.companies.length : 0,
        companyNames: Array.isArray(data.companies)
          ? (data.companies as Array<{ company_name: string }>).slice(0, 5).map((c) => c.company_name)
          : [],
      };
    case "clarify_with_user":
      return { status: data.status };
    case "finalize_search":
      return {
        status: data.status,
        resultCount: data.resultCount,
        overallConfidence: data.overallConfidence,
      };
    default:
      return {};
  }
}

function buildAgentMessages(messages: ChatMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  return messages.slice(-10).map((message) => {
    // For assistant messages, include the company references so agent knows previous results
    if (message.role === "assistant" && message.references && message.references.length > 0) {
      const referenceSummary = message.references
        .map((ref) => `- ${ref.companyName} (${ref.companyId}): ${ref.reason?.slice(0, 100) ?? ""}`)
        .join("\n");
      return {
        role: message.role,
        content: `${message.content}\n\nPrevious search results (company IDs for reference):\n${referenceSummary}`,
      };
    }
    return {
      role: message.role,
      content: message.content,
    };
  });
}

function applyResultConstraints(
  results: PreliminaryResult[],
  requestMode: AgentRequestMode,
  previousCandidateIds: string[],
  targetResultCount: number
): PreliminaryResult[] {
  const previousIdSet = new Set(previousCandidateIds);
  const seen = new Set<string>();
  const constrained: PreliminaryResult[] = [];

  for (const result of results) {
    if (!result.companyId || seen.has(result.companyId)) {
      continue;
    }
    if (requestMode === "more" && previousIdSet.has(result.companyId)) {
      continue;
    }
    if (requestMode === "filter" && previousCandidateIds.length > 0 && !previousIdSet.has(result.companyId)) {
      continue;
    }
    seen.add(result.companyId);
    constrained.push(result);
  }

  return constrained.slice(0, Math.min(MAX_TARGET_RESULT_COUNT, Math.max(1, targetResultCount * 2)));
}

function applyReferenceConstraints(
  references: FinalAnswerPayload["references"],
  requestMode: AgentRequestMode,
  previousCandidateIds: string[],
  targetResultCount: number
): FinalAnswerPayload["references"] {
  const previousIdSet = new Set(previousCandidateIds);
  const seen = new Set<string>();
  const constrained: FinalAnswerPayload["references"] = [];

  for (const reference of references) {
    if (!reference.companyId || seen.has(reference.companyId)) {
      continue;
    }
    if (requestMode === "more" && previousIdSet.has(reference.companyId)) {
      continue;
    }
    if (requestMode === "filter" && previousCandidateIds.length > 0 && !previousIdSet.has(reference.companyId)) {
      continue;
    }
    seen.add(reference.companyId);
    constrained.push(reference);
    if (constrained.length >= targetResultCount) {
      break;
    }
  }

  return constrained;
}

function buildFallbackResponse(message: string): FinalAnswerPayload {
  return {
    content: message,
    references: [],
    companiesById: {},
    telemetry: {
      runId: crypto.randomUUID(),
      iterationCount: 0,
      toolCallCount: 0,
      endReason: "error",
    },
  };
}

interface RunContext {
  supabase: ReturnType<typeof getSupabaseServerClient>;
  runId: string;
  telemetryEnabled: boolean;
  startedAtMs: number;
  state: SearchAgentState;
  stepCounter: number;
  clarificationRequested: boolean;
  toolDurationTotalMs: number;
}

export async function runAgenticSearch(input: AgentOrchestratorInput): Promise<FinalAnswerPayload | null> {
  const env = getServerEnv();
  const supabase = getSupabaseServerClient();
  const startedAtMs = Date.now();
  const runId = crypto.randomUUID();

  const userMessage = input.messages.filter((m) => m.role === "user").at(-1)?.content?.trim() ?? "";
  if (!userMessage) {
    return buildFallbackResponse("No user message found for search.");
  }
  const previousCandidateIds = dedupeCompanyIds(input.clientContext.previousCandidateIds ?? []);
  const requestMode = inferRequestMode(userMessage, previousCandidateIds.length > 0);
  const targetResultCount = extractTargetResultCount(userMessage, requestMode, previousCandidateIds.length);
  const requiresUpfrontClarification = shouldClarifyBeforeSearch(userMessage, requestMode);
  const runtimePrompt = buildAgentRuntimePrompt({
    userMessage,
    requestMode,
    targetResultCount,
    previousCandidateIds,
    shouldClarifyBeforeSearch: requiresUpfrontClarification,
  });

  // Initialize search run telemetry
  const insertedRunId = await insertSearchRun(supabase, {
    id: runId,
    session_id: input.sessionId,
    query_text: userMessage,
    status_scope: ["startup"],
    iteration_count: 0,
    tool_call_count: 0,
    final_candidate_count: 0,
    end_reason: "in_progress",
    latency_ms: 0,
  });
  const telemetryEnabled = insertedRunId !== null;
  if (!telemetryEnabled) {
    console.warn(`[agentic-orchestrator] Telemetry disabled for run ${runId}: search_runs insert failed.`);
  }

  const state: SearchAgentState = {
    candidates: new Map(),
    anchorCompany: null,
    toolCallCount: 0,
    retrievalQueryLog: [],
    enforceQueryVariation: requestMode === "new" || requestMode === "similar",
    hasHighConfidenceExactMatch: false,
    preliminaryResults: null,
    targetResultCount,
    defaultExcludeCompanyIds: requestMode === "more" ? previousCandidateIds : [],
    constrainToCompanyIds: requestMode === "filter" && previousCandidateIds.length > 0 ? previousCandidateIds : null,
    companyDetailsFetchedCount: 0,
    requireClarificationBeforeFinalize: requiresUpfrontClarification,
    clarificationSatisfied: !requiresUpfrontClarification,
    clarificationPending: null,
    clarificationResponse: null,
  };

  const context: RunContext = {
    supabase,
    runId,
    telemetryEnabled,
    startedAtMs,
    state,
    stepCounter: 0,
    clarificationRequested: false,
    toolDurationTotalMs: 0,
  };
  const logStepAsync = (payload: Parameters<typeof insertSearchRunStep>[1]): void => {
    if (!context.telemetryEnabled) {
      return;
    }

    void insertSearchRunStep(supabase, payload).catch((error) => {
      console.error("insertSearchRunStep async write failed", error);
    });
  };

  const tools = createSearchTools({
    supabase,
    embedQuery: async (text) => {
      const startedAt = Date.now();
      const result = await embedMany({
        model: openai.embedding(env.OPENAI_EMBEDDING_MODEL),
        values: [text],
      });
      return {
        embedding: result.embeddings[0],
        durationMs: Date.now() - startedAt,
      };
    },
    state,
    onActivity: input.onActivity,
    onClarificationRequest: (data) => {
      context.clarificationRequested = true;
      if (input.onClarificationRequest) {
        input.onClarificationRequest(data);
      }
    },
  });

  await input.onActivity?.({
    id: "agent-start",
    label: "Starting search",
    detail: `Mode: ${requestMode}; target: ${targetResultCount} results`,
    status: "running",
  });

  try {
    // Phase 1: Agentic search - LLM decides tools based on results
    const agentLoopStartedAt = Date.now();
    const agentResult = await generateText({
      model: openai(env.OPENAI_MODEL),
      system: buildAgentSystemMessage(runtimePrompt),
      messages: buildAgentMessages(input.messages),
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      onStepFinish: async (step) => {
        // Check for timeout
        if (Date.now() - startedAtMs > MAX_RUNTIME_MS) {
          throw new Error("Search timeout exceeded");
        }

        // Build a map of tool results for logging
        const toolResultsMap = new Map<string, unknown>();
        for (const toolResult of step.toolResults ?? []) {
          toolResultsMap.set(toolResult.toolCallId, "output" in toolResult ? toolResult.output : undefined);
        }

        for (const toolCall of step.toolCalls ?? []) {
          context.stepCounter += 1;

          // Get the result for this tool call
          const result = toolResultsMap.get(toolCall.toolCallId);
          const outputSummary = result ? summarizeToolOutput(toolCall.toolName, result) : {};
          const resultRecord = (result ?? {}) as Record<string, unknown>;
          const candidateCountBefore =
            typeof resultRecord.candidateCountBefore === "number"
              ? resultRecord.candidateCountBefore
              : state.candidates.size;
          const candidateCountAfter =
            typeof resultRecord.candidateCountAfter === "number"
              ? resultRecord.candidateCountAfter
              : state.candidates.size;
          const toolDurationMs =
            typeof resultRecord.durationMs === "number" && Number.isFinite(resultRecord.durationMs)
              ? Math.max(0, Math.round(resultRecord.durationMs))
              : 0;
          context.toolDurationTotalMs += toolDurationMs;

          // Log to telemetry asynchronously so writes don't block the search loop.
          logStepAsync({
            run_id: runId,
            iteration_no: 1,
            step_order: context.stepCounter,
            tool_name: `agent.${toolCall.toolName}`,
            input_summary: toolCall.input as Record<string, unknown>,
            output_summary: outputSummary,
            duration_ms: toolDurationMs,
            candidate_count_before: candidateCountBefore,
            candidate_count_after: candidateCountAfter,
          });

          // Emit activity
          await input.onActivity?.({
            id: `tool-${context.stepCounter}`,
            label: formatToolLabel(toolCall.toolName),
            detail: formatToolDetail(toolCall.toolName, toolCall.input),
            status: "completed",
          });

          // Check if clarification was requested
          if (toolCall.toolName === "clarify_with_user" && state.clarificationPending) {
            // Store state for resumption
            pendingClarifications.set(input.sessionId, {
              sessionId: input.sessionId,
              state,
              messages: input.messages,
              runId,
              telemetryEnabled: context.telemetryEnabled,
              startedAtMs,
              runtimePrompt,
              requestMode,
              targetResultCount,
              previousCandidateIds,
            });
          }
        }
      },
    });
    const agentLoopDurationMs = Date.now() - agentLoopStartedAt;
    const agentNonToolMs = Math.max(0, agentLoopDurationMs - context.toolDurationTotalMs);
    const agentUsage = (agentResult as { usage?: unknown }).usage ?? null;
    context.stepCounter += 1;
    logStepAsync({
      run_id: runId,
      iteration_no: 1,
      step_order: context.stepCounter,
      tool_name: "openai.generate_text.agent_loop",
      input_summary: {
        model: env.OPENAI_MODEL,
        hasTools: true,
      },
      output_summary: {
        finishReason: agentResult.finishReason,
        stepCount: agentResult.steps.length,
        toolExecutionMs: context.toolDurationTotalMs,
        nonToolMs: agentNonToolMs,
        usage: agentUsage,
      },
      duration_ms: agentLoopDurationMs,
      candidate_count_before: 0,
      candidate_count_after: state.candidates.size,
    });

    // Log agent reasoning for debugging
    console.log(`[agentic-orchestrator] Agent finished. Steps: ${agentResult.steps.length}, finishReason: ${agentResult.finishReason}`);
    if (agentResult.text) {
      console.log(`[agentic-orchestrator] Agent text: ${agentResult.text.slice(0, 500)}`);
    }
    if (!state.preliminaryResults && state.candidates.size > 0) {
      console.log(`[agentic-orchestrator] Agent has ${state.candidates.size} candidates but didn't call finalize_search`);
    }

    // Check if we're waiting for clarification
    if (context.clarificationRequested && state.clarificationPending) {
      return null;
    }

    // Check if we got a finalize_search call
    if (!state.preliminaryResults) {
      if (state.candidates.size > 0 && state.companyDetailsFetchedCount > 0) {
        console.log(`[agentic-orchestrator] Agent didn't finalize. Applying deterministic fallback with ${state.candidates.size} candidates.`);

        const fallbackPreliminary = Array.from(state.candidates.values())
          .sort((a, b) => b.combinedScore - a.combinedScore)
          .map((candidate) => ({
          companyId: candidate.companyId,
          confidence: Math.min(candidate.combinedScore, 1),
          reason: `Matched via ${candidate.matchedFields.join(", ")}`,
          evidenceChips: candidate.matchedTerms.slice(0, 4),
        }));
        state.preliminaryResults = applyResultConstraints(
          fallbackPreliminary,
          requestMode,
          previousCandidateIds,
          targetResultCount
        );
      } else {
        await updateSearchRun(supabase, runId, {
          end_reason: "guardrail_hit",
          tool_call_count: state.toolCallCount,
          latency_ms: Date.now() - startedAtMs,
        });

        return buildFallbackResponse(
          state.companyDetailsFetchedCount === 0
            ? "Search incomplete: company details were not fetched before finalization. Please retry with a more specific query."
            : "Could not find relevant companies. Try adding more specific terms or company names."
        );
      }
    }
    state.preliminaryResults = applyResultConstraints(
      state.preliminaryResults,
      requestMode,
      previousCandidateIds,
      targetResultCount
    );
    if (!state.preliminaryResults.length) {
      await updateSearchRun(supabase, runId, {
        end_reason: "guardrail_hit",
        tool_call_count: state.toolCallCount,
        latency_ms: Date.now() - startedAtMs,
      });
      return buildFallbackResponse("No candidates satisfy the current request constraints.");
    }

    await input.onActivity?.({
      id: "reranking",
      label: "Reranking results",
      detail: `Analyzing ${state.preliminaryResults.length} candidates`,
      status: "running",
    });

    // Phase 2: Reranker (kept separate for quality)
    const companyDetails = await getCompaniesByIds(
      supabase,
      state.preliminaryResults.map((r) => r.companyId)
    );

    const rerankerStartedAt = Date.now();
    const reranked = await generateObject({
      model: openai(env.OPENAI_MODEL),
      schema: rerankerSchema,
      system: rerankerSystemPrompt,
      prompt: buildRerankerPrompt({
        userMessage,
        candidates: state.preliminaryResults,
        companyDetails,
        targetResultCount,
      }),
    });
    const rerankerDurationMs = Date.now() - rerankerStartedAt;
    const rerankerUsage = (reranked as { usage?: unknown }).usage ?? null;
    context.stepCounter += 1;
    logStepAsync({
      run_id: runId,
      iteration_no: 1,
      step_order: context.stepCounter,
      tool_name: "openai.generate_object.reranker",
      input_summary: {
        model: env.OPENAI_MODEL,
        candidateCount: state.preliminaryResults.length,
      },
      output_summary: {
        confidence: reranked.object.confidence,
        rankedCount: reranked.object.rankedCompanyIds.length,
        perCompanyCount: reranked.object.perCompany.length,
        usage: rerankerUsage,
      },
      duration_ms: rerankerDurationMs,
      candidate_count_before: state.preliminaryResults.length,
      candidate_count_after: state.preliminaryResults.length,
    });

    await input.onActivity?.({
      id: "reranking",
      label: "Reranking results",
      detail: `Confidence: ${(reranked.object.confidence * 100).toFixed(0)}%`,
      status: "completed",
    });

    // Phase 3: Build final response
    const finalCompanyMap = Object.fromEntries(companyDetails.map((c) => [c.id, c]));
    const rerankerData = reranked.object as RerankerOutput;

    const unconstrainedReferences = rerankerData.rankedCompanyIds
      .map((companyId) => {
        const company = finalCompanyMap[companyId];
        const perCompany = rerankerData.perCompany.find((p) => p.companyId === companyId);

        if (!company) {
          return null;
        }

        return {
          companyId: company.id,
          companyName: company.company_name,
          reason: perCompany?.reason ?? company.description ?? "Matched by relevance",
          inlineDescription:
            perCompany?.inlineDescription ?? company.description ?? "",
          evidenceChips: perCompany?.evidenceChips ?? [],
          confidence: perCompany?.confidence ?? 0.5,
        };
      })
      .filter((ref): ref is NonNullable<typeof ref> => ref !== null);
    const references = applyReferenceConstraints(
      unconstrainedReferences,
      requestMode,
      previousCandidateIds,
      targetResultCount
    );
    if (!references.length) {
      await updateSearchRun(supabase, runId, {
        end_reason: "guardrail_hit",
        tool_call_count: state.toolCallCount,
        latency_ms: Date.now() - startedAtMs,
      });
      return buildFallbackResponse("No companies satisfy the requested constraints.");
    }

    // Generate summary
    const summaryPrompt = `Write a concise 2-3 sentence summary for this company search: "${userMessage}".
Requested ${targetResultCount} results. Returning ${references.length} companies. Top matches: ${references.slice(0, 3).map((r) => r.companyName).join(", ")}.
Overall confidence: ${(rerankerData.confidence * 100).toFixed(0)}%. Focus on what was found, not the search process.`;

    const summaryStartedAt = Date.now();
    const summaryResult = await generateText({
      model: openai(env.OPENAI_MODEL),
      prompt: summaryPrompt,
    });
    const summaryDurationMs = Date.now() - summaryStartedAt;
    const summaryUsage = (summaryResult as { usage?: unknown }).usage ?? null;
    context.stepCounter += 1;
    logStepAsync({
      run_id: runId,
      iteration_no: 1,
      step_order: context.stepCounter,
      tool_name: "openai.generate_text.summary",
      input_summary: {
        model: env.OPENAI_MODEL,
      },
      output_summary: {
        textLength: summaryResult.text.length,
        usage: summaryUsage,
      },
      duration_ms: summaryDurationMs,
      candidate_count_before: references.length,
      candidate_count_after: references.length,
    });

    if (input.onPartialText) {
      await input.onPartialText(summaryResult.text.slice(0, 140));
    }

    // Update telemetry
    await updateSearchRun(supabase, runId, {
      iteration_count: 1,
      tool_call_count: state.toolCallCount,
      final_candidate_count: references.length,
      end_reason: "confidence_met",
      latency_ms: Date.now() - startedAtMs,
    });

    if (context.telemetryEnabled) {
      await insertSearchRunResults(
        supabase,
        references.map((ref, index) => ({
          run_id: runId,
          company_id: ref.companyId,
          rank: index + 1,
          confidence: ref.confidence,
          evidence: {
            evidenceChips: ref.evidenceChips,
            reason: ref.reason,
          },
        }))
      );
    }

    return {
      content: summaryResult.text,
      references,
      companiesById: finalCompanyMap,
      telemetry: {
        runId,
        iterationCount: 1,
        toolCallCount: state.toolCallCount,
        endReason: "confidence_met",
      },
    };
  } catch (error) {
    console.error("[agentic-orchestrator] Search run failed", error);

    await updateSearchRun(supabase, runId, {
      end_reason: "error",
      tool_call_count: state.toolCallCount,
      latency_ms: Date.now() - startedAtMs,
    });

    return buildFallbackResponse(SEARCH_UNAVAILABLE_MESSAGE);
  }
}

export async function resumeAgentWithClarification(
  sessionId: string,
  selection: string,
  input: AgentOrchestratorInput
): Promise<FinalAnswerPayload | null> {
  const pending = pendingClarifications.get(sessionId);

  if (!pending) {
    return buildFallbackResponse(
      "Session expired. Please start a new search."
    );
  }

  // Clean up the pending clarification
  pendingClarifications.delete(sessionId);

  // Resume with the clarification response
  const env = getServerEnv();
  const supabase = getSupabaseServerClient();
  const resumeStartedAtMs = Date.now();

  // Update state with the user's selection
  pending.state.clarificationResponse = selection;
  pending.state.clarificationPending = null;
  pending.state.clarificationSatisfied = true;
  const clarifiedMessages: ChatMessage[] = [
    ...pending.messages,
    {
      id: `clarification-${Date.now()}`,
      role: "assistant",
      content: `User clarification provided: "${selection}"`,
      createdAt: new Date().toISOString(),
    },
  ];

  let stepCounter = pending.state.toolCallCount;
  let clarificationRequested = false;
  let resumeToolDurationTotalMs = 0;
  const logResumeStepAsync = (payload: Parameters<typeof insertSearchRunStep>[1]): void => {
    if (!pending.telemetryEnabled) {
      return;
    }

    void insertSearchRunStep(supabase, payload).catch((error) => {
      console.error("insertSearchRunStep async write failed", error);
    });
  };

  const tools = createSearchTools({
    supabase,
    embedQuery: async (text) => {
      const startedAt = Date.now();
      const result = await embedMany({
        model: openai.embedding(env.OPENAI_EMBEDDING_MODEL),
        values: [text],
      });
      return {
        embedding: result.embeddings[0],
        durationMs: Date.now() - startedAt,
      };
    },
    state: pending.state,
    onActivity: input.onActivity,
    onClarificationRequest: (data) => {
      clarificationRequested = true;
      if (input.onClarificationRequest) {
        input.onClarificationRequest(data);
      }
    },
  });

  await input.onActivity?.({
    id: "resume",
    label: "Resuming search",
    detail: `User selected: "${selection}"`,
    status: "completed",
  });

  try {
    // Build messages with the clarification context
    const resumeMessages = [
      ...buildAgentMessages(clarifiedMessages),
      {
        role: "user" as const,
        content: `The user clarified their intent: "${selection}". Continue the search with this understanding.`,
      },
    ];

    // Continue the agentic search
    const resumeAgentLoopStartedAt = Date.now();
    const resumeAgentResult = await generateText({
      model: openai(env.OPENAI_MODEL),
      system: buildAgentSystemMessage(pending.runtimePrompt),
      messages: resumeMessages,
      tools,
      stopWhen: stepCountIs(MAX_STEPS - pending.state.toolCallCount),
      onStepFinish: async (step) => {
        if (Date.now() - resumeStartedAtMs > MAX_RUNTIME_MS) {
          throw new Error("Search timeout exceeded");
        }

        // Build a map of tool results for logging
        const toolResultsMap = new Map<string, unknown>();
        for (const toolResult of step.toolResults ?? []) {
          toolResultsMap.set(toolResult.toolCallId, "output" in toolResult ? toolResult.output : undefined);
        }

        for (const toolCall of step.toolCalls ?? []) {
          stepCounter += 1;

          // Get the result for this tool call
          const result = toolResultsMap.get(toolCall.toolCallId);
          const outputSummary = result ? summarizeToolOutput(toolCall.toolName, result) : {};
          const resultRecord = (result ?? {}) as Record<string, unknown>;
          const candidateCountBefore =
            typeof resultRecord.candidateCountBefore === "number"
              ? resultRecord.candidateCountBefore
              : pending.state.candidates.size;
          const candidateCountAfter =
            typeof resultRecord.candidateCountAfter === "number"
              ? resultRecord.candidateCountAfter
              : pending.state.candidates.size;
          const toolDurationMs =
            typeof resultRecord.durationMs === "number" && Number.isFinite(resultRecord.durationMs)
              ? Math.max(0, Math.round(resultRecord.durationMs))
              : 0;
          resumeToolDurationTotalMs += toolDurationMs;

          // Log to telemetry asynchronously so writes don't block the search loop.
          logResumeStepAsync({
            run_id: pending.runId,
            iteration_no: 2,
            step_order: stepCounter,
            tool_name: `agent.${toolCall.toolName}`,
            input_summary: toolCall.input as Record<string, unknown>,
            output_summary: outputSummary,
            duration_ms: toolDurationMs,
            candidate_count_before: candidateCountBefore,
            candidate_count_after: candidateCountAfter,
          });

          await input.onActivity?.({
            id: `tool-${stepCounter}`,
            label: formatToolLabel(toolCall.toolName),
            detail: formatToolDetail(toolCall.toolName, toolCall.input),
            status: "completed",
          });

          if (toolCall.toolName === "clarify_with_user" && pending.state.clarificationPending) {
            pendingClarifications.set(sessionId, {
              sessionId,
              state: pending.state,
              messages: clarifiedMessages,
              runId: pending.runId,
              telemetryEnabled: pending.telemetryEnabled,
              startedAtMs: pending.startedAtMs,
              runtimePrompt: pending.runtimePrompt,
              requestMode: pending.requestMode,
              targetResultCount: pending.targetResultCount,
              previousCandidateIds: pending.previousCandidateIds,
            });
          }
        }
      },
    });
    const resumeAgentLoopDurationMs = Date.now() - resumeAgentLoopStartedAt;
    const resumeAgentNonToolMs = Math.max(0, resumeAgentLoopDurationMs - resumeToolDurationTotalMs);
    const resumeAgentUsage = (resumeAgentResult as { usage?: unknown }).usage ?? null;
    stepCounter += 1;
    logResumeStepAsync({
      run_id: pending.runId,
      iteration_no: 2,
      step_order: stepCounter,
      tool_name: "openai.generate_text.agent_loop",
      input_summary: {
        model: env.OPENAI_MODEL,
        hasTools: true,
        resumed: true,
      },
      output_summary: {
        finishReason: resumeAgentResult.finishReason,
        stepCount: resumeAgentResult.steps.length,
        toolExecutionMs: resumeToolDurationTotalMs,
        nonToolMs: resumeAgentNonToolMs,
        usage: resumeAgentUsage,
      },
      duration_ms: resumeAgentLoopDurationMs,
      candidate_count_before: 0,
      candidate_count_after: pending.state.candidates.size,
    });

    if (clarificationRequested && pending.state.clarificationPending) {
      if (!pendingClarifications.has(sessionId)) {
        pendingClarifications.set(sessionId, {
          sessionId,
          state: pending.state,
          messages: clarifiedMessages,
          runId: pending.runId,
          telemetryEnabled: pending.telemetryEnabled,
          startedAtMs: pending.startedAtMs,
          runtimePrompt: pending.runtimePrompt,
          requestMode: pending.requestMode,
          targetResultCount: pending.targetResultCount,
          previousCandidateIds: pending.previousCandidateIds,
        });
      }
      return null;
    }

    if (!pending.state.preliminaryResults) {
      if (pending.state.candidates.size > 0 && pending.state.companyDetailsFetchedCount > 0) {
        console.log(`[agentic-orchestrator] Agent didn't finalize after resume. Applying deterministic fallback with ${pending.state.candidates.size} candidates.`);

        const fallbackPreliminary = Array.from(pending.state.candidates.values())
          .sort((a, b) => b.combinedScore - a.combinedScore)
          .map((candidate) => ({
          companyId: candidate.companyId,
          confidence: Math.min(candidate.combinedScore, 1),
          reason: `Matched via ${candidate.matchedFields.join(", ")}`,
          evidenceChips: candidate.matchedTerms.slice(0, 4),
        }));
        pending.state.preliminaryResults = applyResultConstraints(
          fallbackPreliminary,
          pending.requestMode,
          pending.previousCandidateIds,
          pending.targetResultCount
        );
      } else {
        await updateSearchRun(supabase, pending.runId, {
          end_reason: "guardrail_hit",
          tool_call_count: pending.state.toolCallCount,
          latency_ms: Date.now() - pending.startedAtMs,
        });

        return buildFallbackResponse(
          "Could not find relevant companies after clarification. Try a different search."
        );
      }
    }
    pending.state.preliminaryResults = applyResultConstraints(
      pending.state.preliminaryResults,
      pending.requestMode,
      pending.previousCandidateIds,
      pending.targetResultCount
    );
    if (!pending.state.preliminaryResults.length) {
      await updateSearchRun(supabase, pending.runId, {
        end_reason: "guardrail_hit",
        tool_call_count: pending.state.toolCallCount,
        latency_ms: Date.now() - pending.startedAtMs,
      });
      return buildFallbackResponse("No candidates satisfy the current request constraints.");
    }

    await input.onActivity?.({
      id: "reranking",
      label: "Reranking results",
      detail: `Analyzing ${pending.state.preliminaryResults.length} candidates`,
      status: "running",
    });

    // Rerank
    const companyDetails = await getCompaniesByIds(
      supabase,
      pending.state.preliminaryResults.map((r) => r.companyId)
    );

    const userMessage = clarifiedMessages.filter((m) => m.role === "user").at(-1)?.content?.trim() ?? "";

    const resumeRerankerStartedAt = Date.now();
    const reranked = await generateObject({
      model: openai(env.OPENAI_MODEL),
      schema: rerankerSchema,
      system: rerankerSystemPrompt,
      prompt: buildRerankerPrompt({
        userMessage: `${userMessage} (User clarified: ${selection})`,
        candidates: pending.state.preliminaryResults,
        companyDetails,
        targetResultCount: pending.targetResultCount,
      }),
    });
    const resumeRerankerDurationMs = Date.now() - resumeRerankerStartedAt;
    const resumeRerankerUsage = (reranked as { usage?: unknown }).usage ?? null;
    stepCounter += 1;
    logResumeStepAsync({
      run_id: pending.runId,
      iteration_no: 2,
      step_order: stepCounter,
      tool_name: "openai.generate_object.reranker",
      input_summary: {
        model: env.OPENAI_MODEL,
        candidateCount: pending.state.preliminaryResults.length,
        resumed: true,
      },
      output_summary: {
        confidence: reranked.object.confidence,
        rankedCount: reranked.object.rankedCompanyIds.length,
        perCompanyCount: reranked.object.perCompany.length,
        usage: resumeRerankerUsage,
      },
      duration_ms: resumeRerankerDurationMs,
      candidate_count_before: pending.state.preliminaryResults.length,
      candidate_count_after: pending.state.preliminaryResults.length,
    });

    await input.onActivity?.({
      id: "reranking",
      label: "Reranking results",
      detail: `Confidence: ${(reranked.object.confidence * 100).toFixed(0)}%`,
      status: "completed",
    });

    const finalCompanyMap = Object.fromEntries(companyDetails.map((c) => [c.id, c]));
    const rerankerData = reranked.object as RerankerOutput;

    const unconstrainedReferences = rerankerData.rankedCompanyIds
      .map((companyId) => {
        const company = finalCompanyMap[companyId];
        const perCompany = rerankerData.perCompany.find((p) => p.companyId === companyId);

        if (!company) {
          return null;
        }

        return {
          companyId: company.id,
          companyName: company.company_name,
          reason: perCompany?.reason ?? company.description ?? "Matched by relevance",
          inlineDescription: perCompany?.inlineDescription ?? company.description ?? "",
          evidenceChips: perCompany?.evidenceChips ?? [],
          confidence: perCompany?.confidence ?? 0.5,
        };
      })
      .filter((ref): ref is NonNullable<typeof ref> => ref !== null);
    const references = applyReferenceConstraints(
      unconstrainedReferences,
      pending.requestMode,
      pending.previousCandidateIds,
      pending.targetResultCount
    );
    if (!references.length) {
      await updateSearchRun(supabase, pending.runId, {
        end_reason: "guardrail_hit",
        tool_call_count: pending.state.toolCallCount,
        latency_ms: Date.now() - pending.startedAtMs,
      });
      return buildFallbackResponse("No companies satisfy the requested constraints.");
    }

    const summaryPrompt = `Write a concise 2-3 sentence summary for this company search: "${userMessage}" (clarified as: ${selection}).
Requested ${pending.targetResultCount} results. Returning ${references.length} companies. Top matches: ${references.slice(0, 3).map((r) => r.companyName).join(", ")}.
Overall confidence: ${(rerankerData.confidence * 100).toFixed(0)}%. Focus on what was found.`;

    const resumeSummaryStartedAt = Date.now();
    const summaryResult = await generateText({
      model: openai(env.OPENAI_MODEL),
      prompt: summaryPrompt,
    });
    const resumeSummaryDurationMs = Date.now() - resumeSummaryStartedAt;
    const resumeSummaryUsage = (summaryResult as { usage?: unknown }).usage ?? null;
    stepCounter += 1;
    logResumeStepAsync({
      run_id: pending.runId,
      iteration_no: 2,
      step_order: stepCounter,
      tool_name: "openai.generate_text.summary",
      input_summary: {
        model: env.OPENAI_MODEL,
        resumed: true,
      },
      output_summary: {
        textLength: summaryResult.text.length,
        usage: resumeSummaryUsage,
      },
      duration_ms: resumeSummaryDurationMs,
      candidate_count_before: references.length,
      candidate_count_after: references.length,
    });

    if (input.onPartialText) {
      await input.onPartialText(summaryResult.text.slice(0, 140));
    }

    await updateSearchRun(supabase, pending.runId, {
      iteration_count: 2,
      tool_call_count: pending.state.toolCallCount,
      final_candidate_count: references.length,
      end_reason: "confidence_met",
      latency_ms: Date.now() - pending.startedAtMs,
    });

    if (pending.telemetryEnabled) {
      await insertSearchRunResults(
        supabase,
        references.map((ref, index) => ({
          run_id: pending.runId,
          company_id: ref.companyId,
          rank: index + 1,
          confidence: ref.confidence,
          evidence: {
            evidenceChips: ref.evidenceChips,
            reason: ref.reason,
          },
        }))
      );
    }

    return {
      content: summaryResult.text,
      references,
      companiesById: finalCompanyMap,
      telemetry: {
        runId: pending.runId,
        iterationCount: 2,
        toolCallCount: pending.state.toolCallCount,
        endReason: "confidence_met",
      },
    };
  } catch (error) {
    console.error("[agentic-orchestrator] Resume search failed", error);

    await updateSearchRun(supabase, pending.runId, {
      end_reason: "error",
      tool_call_count: pending.state.toolCallCount,
      latency_ms: Date.now() - pending.startedAtMs,
    });

    return buildFallbackResponse(SEARCH_UNAVAILABLE_MESSAGE);
  }
}

export function hasPendingClarification(sessionId: string): boolean {
  return pendingClarifications.has(sessionId);
}
