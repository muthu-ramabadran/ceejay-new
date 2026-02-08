import { embedMany, generateObject, generateText, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";

import { getServerEnv } from "@/lib/env";
import { agentSystemPrompt } from "@/lib/agent/prompts";
import { rerankerSchema, type RerankerOutput } from "@/lib/agent/schemas";
import { createSearchTools, type PreliminaryResult, type SearchAgentState } from "@/lib/agent/tools";
import { getCompaniesByIds } from "@/lib/search/rpc";
import { insertSearchRun, insertSearchRunResults, insertSearchRunStep, updateSearchRun } from "@/lib/search/telemetry";
import type { FinalAnswerPayload } from "@/lib/search/types";
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
  startedAtMs: number;
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
const MAX_RUNTIME_MS = 60_000;

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
}): string {
  const companyMap = new Map(input.companyDetails.map((c) => [c.id, c]));

  const candidateBlock = input.candidates
    .slice(0, 20)
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
    case "search_semantic":
    case "search_keyword":
      return {
        totalFound: data.totalFound,
        resultCount: Array.isArray(data.results) ? data.results.length : 0,
        topIds: Array.isArray(data.results)
          ? (data.results as Array<{ companyId: string }>).slice(0, 5).map((r) => r.companyId)
          : [],
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
  return messages.slice(-6).map((message) => {
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
  startedAtMs: number;
  state: SearchAgentState;
  stepCounter: number;
  clarificationRequested: boolean;
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

  // Initialize search run telemetry
  await insertSearchRun(supabase, {
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

  const state: SearchAgentState = {
    candidates: new Map(),
    anchorCompany: null,
    toolCallCount: 0,
    preliminaryResults: null,
    clarificationPending: null,
    clarificationResponse: null,
  };

  const context: RunContext = {
    supabase,
    runId,
    startedAtMs,
    state,
    stepCounter: 0,
    clarificationRequested: false,
  };

  const tools = createSearchTools({
    supabase,
    embedQuery: async (text) => {
      const result = await embedMany({
        model: openai.embedding(env.OPENAI_EMBEDDING_MODEL),
        values: [text],
      });
      return result.embeddings[0];
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
    detail: "Analyzing query and planning search strategy",
    status: "running",
  });

  try {
    // Phase 1: Agentic search - LLM decides tools based on results
    const agentResult = await generateText({
      model: openai(env.OPENAI_MODEL),
      system: agentSystemPrompt,
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

          // Log to telemetry
          await insertSearchRunStep(supabase, {
            run_id: runId,
            iteration_no: 1,
            step_order: context.stepCounter,
            tool_name: `agent.${toolCall.toolName}`,
            input_summary: toolCall.input as Record<string, unknown>,
            output_summary: outputSummary,
            duration_ms: 0,
            candidate_count_before: state.candidates.size,
            candidate_count_after: state.candidates.size,
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
              startedAtMs,
            });
          }
        }
      },
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
      // Agent didn't call finalize_search, but we may have candidates - auto-finalize
      if (state.candidates.size > 0) {
        console.log(`[agentic-orchestrator] Agent didn't finalize. Auto-finalizing with ${state.candidates.size} candidates.`);

        // Sort candidates by combined score and take top 15
        const sortedCandidates = Array.from(state.candidates.values())
          .sort((a, b) => b.combinedScore - a.combinedScore)
          .slice(0, 15);

        state.preliminaryResults = sortedCandidates.map((candidate) => ({
          companyId: candidate.companyId,
          confidence: Math.min(candidate.combinedScore, 1),
          reason: `Matched via ${candidate.matchedFields.join(", ")}`,
          evidenceChips: candidate.matchedTerms.slice(0, 4),
        }));
      } else {
        await updateSearchRun(supabase, runId, {
          end_reason: "guardrail_hit",
          tool_call_count: state.toolCallCount,
          latency_ms: Date.now() - startedAtMs,
        });

        return buildFallbackResponse(
          "Could not find relevant companies. Try adding more specific terms or company names."
        );
      }
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

    const reranked = await generateObject({
      model: openai(env.OPENAI_MODEL),
      schema: rerankerSchema,
      system: rerankerSystemPrompt,
      prompt: buildRerankerPrompt({
        userMessage,
        candidates: state.preliminaryResults,
        companyDetails,
      }),
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

    const references = rerankerData.rankedCompanyIds
      .slice(0, 15)
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

    // Generate summary
    const summaryPrompt = `Write a concise 2-3 sentence summary for this company search: "${userMessage}".
Found ${references.length} companies. Top matches: ${references.slice(0, 3).map((r) => r.companyName).join(", ")}.
Overall confidence: ${(rerankerData.confidence * 100).toFixed(0)}%. Focus on what was found, not the search process.`;

    const summaryResult = await generateText({
      model: openai(env.OPENAI_MODEL),
      prompt: summaryPrompt,
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
    const message = error instanceof Error ? error.message : "Search failed";

    await updateSearchRun(supabase, runId, {
      end_reason: "error",
      tool_call_count: state.toolCallCount,
      latency_ms: Date.now() - startedAtMs,
    });

    return buildFallbackResponse(`Search failed: ${message}`);
  }
}

export async function resumeAgentWithClarification(
  sessionId: string,
  selection: string,
  input: AgentOrchestratorInput
): Promise<FinalAnswerPayload> {
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

  // Update state with the user's selection
  pending.state.clarificationResponse = selection;
  pending.state.clarificationPending = null;

  let stepCounter = pending.state.toolCallCount;

  const tools = createSearchTools({
    supabase,
    embedQuery: async (text) => {
      const result = await embedMany({
        model: openai.embedding(env.OPENAI_EMBEDDING_MODEL),
        values: [text],
      });
      return result.embeddings[0];
    },
    state: pending.state,
    onActivity: input.onActivity,
    onClarificationRequest: () => {
      // Note: nested clarification not currently supported in resume flow
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
      ...buildAgentMessages(pending.messages),
      {
        role: "user" as const,
        content: `The user clarified their intent: "${selection}". Continue the search with this understanding.`,
      },
    ];

    // Continue the agentic search
    await generateText({
      model: openai(env.OPENAI_MODEL),
      system: agentSystemPrompt,
      messages: resumeMessages,
      tools,
      stopWhen: stepCountIs(MAX_STEPS - pending.state.toolCallCount),
      onStepFinish: async (step) => {
        if (Date.now() - pending.startedAtMs > MAX_RUNTIME_MS) {
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

          await insertSearchRunStep(supabase, {
            run_id: pending.runId,
            iteration_no: 2,
            step_order: stepCounter,
            tool_name: `agent.${toolCall.toolName}`,
            input_summary: toolCall.input as Record<string, unknown>,
            output_summary: outputSummary,
            duration_ms: 0,
            candidate_count_before: pending.state.candidates.size,
            candidate_count_after: pending.state.candidates.size,
          });

          await input.onActivity?.({
            id: `tool-${stepCounter}`,
            label: formatToolLabel(toolCall.toolName),
            detail: formatToolDetail(toolCall.toolName, toolCall.input),
            status: "completed",
          });
        }
      },
    });

    if (!pending.state.preliminaryResults) {
      // Agent didn't call finalize_search, but we may have candidates - auto-finalize
      if (pending.state.candidates.size > 0) {
        console.log(`[agentic-orchestrator] Agent didn't finalize after resume. Auto-finalizing with ${pending.state.candidates.size} candidates.`);

        const sortedCandidates = Array.from(pending.state.candidates.values())
          .sort((a, b) => b.combinedScore - a.combinedScore)
          .slice(0, 15);

        pending.state.preliminaryResults = sortedCandidates.map((candidate) => ({
          companyId: candidate.companyId,
          confidence: Math.min(candidate.combinedScore, 1),
          reason: `Matched via ${candidate.matchedFields.join(", ")}`,
          evidenceChips: candidate.matchedTerms.slice(0, 4),
        }));
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

    const userMessage = pending.messages.filter((m) => m.role === "user").at(-1)?.content?.trim() ?? "";

    const reranked = await generateObject({
      model: openai(env.OPENAI_MODEL),
      schema: rerankerSchema,
      system: rerankerSystemPrompt,
      prompt: buildRerankerPrompt({
        userMessage: `${userMessage} (User clarified: ${selection})`,
        candidates: pending.state.preliminaryResults,
        companyDetails,
      }),
    });

    await input.onActivity?.({
      id: "reranking",
      label: "Reranking results",
      detail: `Confidence: ${(reranked.object.confidence * 100).toFixed(0)}%`,
      status: "completed",
    });

    const finalCompanyMap = Object.fromEntries(companyDetails.map((c) => [c.id, c]));
    const rerankerData = reranked.object as RerankerOutput;

    const references = rerankerData.rankedCompanyIds
      .slice(0, 15)
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

    const summaryPrompt = `Write a concise 2-3 sentence summary for this company search: "${userMessage}" (clarified as: ${selection}).
Found ${references.length} companies. Top matches: ${references.slice(0, 3).map((r) => r.companyName).join(", ")}.
Overall confidence: ${(rerankerData.confidence * 100).toFixed(0)}%. Focus on what was found.`;

    const summaryResult = await generateText({
      model: openai(env.OPENAI_MODEL),
      prompt: summaryPrompt,
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
    const message = error instanceof Error ? error.message : "Search failed";

    await updateSearchRun(supabase, pending.runId, {
      end_reason: "error",
      tool_call_count: pending.state.toolCallCount,
      latency_ms: Date.now() - pending.startedAtMs,
    });

    return buildFallbackResponse(`Search failed: ${message}`);
  }
}

export function hasPendingClarification(sessionId: string): boolean {
  return pendingClarifications.has(sessionId);
}
