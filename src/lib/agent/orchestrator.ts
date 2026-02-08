import { embedMany, generateObject, generateText } from "ai";
import { openai } from "@ai-sdk/openai";

import { getServerEnv } from "@/lib/env";
import {
  buildCriticPrompt,
  buildPlannerPrompt,
  buildRerankerPrompt,
  criticSystemPrompt,
  getSearchableFieldsPrompt,
  plannerSystemPrompt,
  rerankerSystemPrompt,
} from "@/lib/agent/prompts";
import { criticSchema, plannerSchema, rerankerSchema, type CriticOutput, type PlannerOutput, type RerankerOutput } from "@/lib/agent/schemas";
import {
  getCompaniesByIds,
  searchByTaxonomy,
  searchExactName,
  searchHybrid,
  searchKeyword,
} from "@/lib/search/rpc";
import { BUSINESS_MODELS, CATEGORIES_BY_SECTOR, SECTORS, getTaxonomyPrompt } from "@/lib/search/taxonomy";
import { insertSearchRun, insertSearchRunResults, insertSearchRunStep, updateSearchRun } from "@/lib/search/telemetry";
import type {
  AgentPlan,
  FinalAnswerPayload,
  RankedCandidate,
  SearchCandidate,
  SearchLoopLimits,
  SearchLoopState,
} from "@/lib/search/types";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import type { AgentActivityEventPayload, ChatMessage } from "@/types/chat";
import type { Company } from "@/types/company";

export interface AgentOrchestratorInput {
  messages: ChatMessage[];
  clientContext: {
    previousCandidateIds: string[];
  };
  sessionId: string;
  onActivity?: (event: AgentActivityEventPayload) => Promise<void> | void;
  onPartialText?: (value: string) => Promise<void> | void;
}

const LOOP_LIMITS: SearchLoopLimits = {
  maxIterations: 10,
  maxToolCalls: 40,
  maxRuntimeMs: 60_000,
};
const EXACT_SHORT_CIRCUIT_THRESHOLD = 0.95;
const ANCHOR_MATCH_THRESHOLD = 0.8;

function truncateText(value: string, maxLength = 4000): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...[truncated ${value.length - maxLength} chars]`;
}

function normalizeLooseText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function isSimilarityIntent(text: string): boolean {
  return /\b(like|similar|competitor|alternative|alternatives|vs|versus|comparable)\b/i.test(text);
}

function cleanAnchorCandidate(value: string): string {
  return value
    .trim()
    .replace(/^[^a-z0-9]+/i, "")
    .replace(/[^a-z0-9]+$/i, "")
    .replace(/\s+/g, " ")
    .replace(/\b(?:companies|company|startups?|businesses)\b$/i, "")
    .trim();
}

function extractAnchorNameCandidates(userMessage: string): string[] {
  const collected: string[] = [userMessage];

  for (const match of userMessage.matchAll(/["']([^"']{2,80})["']/g)) {
    const captured = match[1];
    if (captured) {
      collected.push(captured);
    }
  }

  for (const match of userMessage.matchAll(/\b(?:like|similar to|similar|competitors? of|competitors?|alternative(?:s)? to|vs|versus)\s+([a-z0-9][a-z0-9.\- ]{1,80})/gi)) {
    const captured = match[1];
    if (captured) {
      collected.push(captured);
    }
  }

  for (const token of userMessage.split(/\s+/)) {
    if (/[a-z]/i.test(token) && /\d/.test(token)) {
      collected.push(token);
    }
  }

  const expanded: string[] = [];
  for (const raw of collected) {
    const cleaned = cleanAnchorCandidate(raw);
    if (!cleaned || cleaned.length < 2) {
      continue;
    }
    expanded.push(cleaned);
    expanded.push(cleaned.replace(/-/g, " "));
    expanded.push(cleaned.replace(/[^a-z0-9]/gi, ""));
  }

  return dedupeStrings(expanded).slice(0, 8);
}

function buildAnchorContext(company: Company): string {
  return [
    `company_name: ${company.company_name}`,
    `tagline: ${company.tagline ?? ""}`,
    `description: ${company.description ?? ""}`,
    `product_description: ${company.product_description ?? ""}`,
    `target_customer: ${company.target_customer ?? ""}`,
    `problem_solved: ${company.problem_solved ?? ""}`,
    `differentiator: ${company.differentiator ?? ""}`,
    `niches: ${company.niches.join(", ")}`,
    `sectors: ${company.sectors.join(", ")}`,
    `categories: ${company.categories.join(", ")}`,
    `business_models: ${company.business_models.join(", ")}`,
  ].join("\n");
}

function isAnchorPlaceholderQuery(query: string, anchorCompanyName: string): boolean {
  const hasSimilarityPhrase = /\b(like|similar|competitor|alternative|alternatives|vs|versus)\b/i.test(query);
  const anchorNorm = normalizeLooseText(anchorCompanyName);
  if (!anchorNorm) {
    return false;
  }

  return hasSimilarityPhrase && normalizeLooseText(query).includes(anchorNorm);
}

function buildAnchorFallbackQueries(anchorCompany: Company): string[] {
  const queries: string[] = [];
  const topNiches = anchorCompany.niches.slice(0, 3).join(" ");
  const topCategory = anchorCompany.categories[0] ?? "";
  const topSector = anchorCompany.sectors[0] ?? "";

  if (topNiches) {
    queries.push(`${topNiches} startups`);
    queries.push(`${topNiches} companies`);
  }

  if (topSector || topCategory) {
    queries.push(`${topSector} ${topCategory} companies`.trim());
  }

  const profileSentence = anchorCompany.product_description
    ?? anchorCompany.problem_solved
    ?? anchorCompany.description
    ?? anchorCompany.tagline
    ?? "";
  if (profileSentence) {
    queries.push(profileSentence);
  }

  return dedupeStrings(queries).slice(0, 4);
}

function asSummary(messages: ChatMessage[]): string {
  return messages
    .slice(-6)
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n")
    .slice(0, 2200);
}

function buildCandidateMap(existing: Map<string, SearchCandidate>, incoming: SearchCandidate[]): void {
  for (const candidate of incoming) {
    const current = existing.get(candidate.companyId);
    if (!current) {
      existing.set(candidate.companyId, candidate);
      continue;
    }

    existing.set(candidate.companyId, {
      ...current,
      semanticScore: Math.max(current.semanticScore, candidate.semanticScore),
      keywordScore: Math.max(current.keywordScore, candidate.keywordScore),
      nicheScore: Math.max(current.nicheScore, candidate.nicheScore),
      exactMatchScore: Math.max(current.exactMatchScore, candidate.exactMatchScore),
      combinedScore: Math.max(current.combinedScore, candidate.combinedScore),
      matchedFields: Array.from(new Set([...current.matchedFields, ...candidate.matchedFields])),
      matchedTerms: Array.from(new Set([...current.matchedTerms, ...candidate.matchedTerms])),
      evidenceChips: Array.from(new Set([...current.evidenceChips, ...candidate.evidenceChips])),
    });
  }
}

function defaultPlan(userMessage: string): AgentPlan {
  return {
    intent: "discover",
    targetResultCount: 12,
    queryVariants: [userMessage],
    searchPriorityOrder: ["exact_name", "hybrid", "keyword", "taxonomy"],
    filters: {
      statuses: ["startup"],
      sectors: [],
      categories: [],
      businessModels: [],
      niches: [],
      nicheMode: "boost",
    },
    successCriteria: "Find highest relevance companies for the request.",
  };
}

function normalizeStatuses(statuses: string[]): string[] {
  const unique = Array.from(new Set(statuses.map((status) => status.trim()).filter(Boolean)));
  return unique.length ? unique : ["startup"];
}

function normalizeTaxonomy(plan: AgentPlan): AgentPlan {
  const allowedCategories = new Set<string>(Object.values(CATEGORIES_BY_SECTOR).flat());
  const sectorSet = new Set<string>(SECTORS);
  const businessModelSet = new Set<string>(BUSINESS_MODELS);

  return {
    ...plan,
    filters: {
      ...plan.filters,
      statuses: normalizeStatuses(plan.filters.statuses),
      sectors: plan.filters.sectors.filter((sector) => sectorSet.has(sector)),
      categories: plan.filters.categories.filter((category) => allowedCategories.has(category)),
      businessModels: plan.filters.businessModels.filter((model) => businessModelSet.has(model)),
      niches: plan.filters.niches,
    },
  };
}

function filterCandidatesByPlan(candidates: RankedCandidate[], companiesById: Record<string, Company>, plan: AgentPlan): RankedCandidate[] {
  return candidates.filter((candidate) => {
    const company = companiesById[candidate.companyId];
    if (!company) {
      return false;
    }

    if (plan.filters.statuses.length && !plan.filters.statuses.includes(company.status)) {
      return false;
    }

    if (
      plan.filters.sectors.length &&
      !company.sectors.some((value) => plan.filters.sectors.includes(value))
    ) {
      return false;
    }

    if (
      plan.filters.categories.length &&
      !company.categories.some((value) => plan.filters.categories.includes(value))
    ) {
      return false;
    }

    if (
      plan.filters.businessModels.length &&
      !company.business_models.some((value) => plan.filters.businessModels.includes(value))
    ) {
      return false;
    }

    if (plan.filters.nicheMode === "must_match" && plan.filters.niches.length) {
      const haystack = `${company.niches.join(" ")} ${company.description ?? ""} ${company.product_description ?? ""}`.toLowerCase();
      const match = plan.filters.niches.some((niche) => haystack.includes(niche.toLowerCase()));
      if (!match) {
        return false;
      }
    }

    return true;
  });
}

function sortCandidates(candidates: SearchCandidate[]): RankedCandidate[] {
  return candidates
    .slice()
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .map((candidate, index) => ({
      ...candidate,
      rank: index + 1,
      confidence: Math.min(1, Math.max(0, candidate.combinedScore)),
      reason: candidate.evidenceChips.join(" · ") || "Matched by relevance",
    }));
}

function toSearchCandidateFromExact(companyId: string, score: number): SearchCandidate {
  return {
    companyId,
    semanticScore: 0,
    keywordScore: 0,
    nicheScore: 0,
    combinedScore: score,
    exactMatchScore: score,
    matchedFields: ["company_name"],
    matchedTerms: [],
    evidenceChips: ["Exact Name"],
  };
}

function toSearchCandidateFromHybrid(row: Awaited<ReturnType<typeof searchHybrid>>[number]): SearchCandidate {
  return {
    companyId: row.companyId,
    semanticScore: row.semanticScore,
    keywordScore: row.keywordScore,
    nicheScore: row.nicheScore,
    combinedScore: row.combinedScore,
    exactMatchScore: 0,
    matchedFields: row.matchedFields,
    matchedTerms: row.matchedTerms,
    evidenceChips: ["Hybrid Match"],
  };
}

function toSearchCandidateFromKeyword(row: Awaited<ReturnType<typeof searchKeyword>>[number]): SearchCandidate {
  return {
    companyId: row.companyId,
    semanticScore: 0,
    keywordScore: row.keywordScore,
    nicheScore: row.nicheScore,
    combinedScore: row.combinedScore,
    exactMatchScore: 0,
    matchedFields: ["keyword"],
    matchedTerms: row.matchedTerms,
    evidenceChips: ["Keyword Match"],
  };
}

function toSearchCandidateFromTaxonomy(row: Awaited<ReturnType<typeof searchByTaxonomy>>[number]): SearchCandidate {
  return {
    companyId: row.companyId,
    semanticScore: 0,
    keywordScore: 0,
    nicheScore: 0,
    combinedScore: row.tagScore,
    exactMatchScore: 0,
    matchedFields: ["taxonomy"],
    matchedTerms: [],
    evidenceChips: ["Taxonomy Match"],
  };
}

async function emitActivity(
  input: AgentOrchestratorInput,
  payload: AgentActivityEventPayload,
): Promise<void> {
  if (!input.onActivity) {
    return;
  }

  await input.onActivity(payload);
}

function converged(previousTopIds: string[], currentTopIds: string[]): boolean {
  if (!previousTopIds.length || !currentTopIds.length) {
    return false;
  }

  return previousTopIds.slice(0, 5).join(",") === currentTopIds.slice(0, 5).join(",");
}

export async function runAgenticSearch(input: AgentOrchestratorInput): Promise<FinalAnswerPayload> {
  const env = getServerEnv();
  const supabase = getSupabaseServerClient();
  const startedAtMs = Date.now();
  const runId = crypto.randomUUID();

  const userMessage = input.messages.filter((message) => message.role === "user").at(-1)?.content?.trim() ?? "";
  if (!userMessage) {
    throw new Error("No user message found for search.");
  }

  const state: SearchLoopState = {
    startedAtMs,
    iteration: 0,
    toolCalls: 0,
    priorTopIds: input.clientContext.previousCandidateIds,
    previousBestScore: 0,
  };

  const similarityIntent = isSimilarityIntent(userMessage);
  const exactNameInputs = extractAnchorNameCandidates(userMessage);

  let endReason: "exact_match" | "confidence_met" | "converged" | "guardrail_hit" | "error" = "guardrail_hit";
  let finalCandidates: RankedCandidate[] = [];
  let finalPlan: AgentPlan = defaultPlan(userMessage);
  let anchorCompany: Company | null = null;
  let runRowCreated = false;

  const insertedRunId = await insertSearchRun(supabase, {
    id: runId,
    session_id: input.sessionId,
    query_text: userMessage,
    status_scope: finalPlan.filters.statuses,
    iteration_count: 0,
    tool_call_count: 0,
    final_candidate_count: 0,
    end_reason: "in_progress",
    latency_ms: 0,
  });
  runRowCreated = insertedRunId !== null;

  const logStep = async (payload: {
    iterationNo: number;
    stepOrder: number;
    toolName: string;
    inputSummary: Record<string, unknown>;
    outputSummary: Record<string, unknown>;
    durationMs: number;
    before: number;
    after: number;
  }): Promise<void> => {
    if (!runRowCreated) {
      return;
    }

    await insertSearchRunStep(supabase, {
      run_id: runId,
      iteration_no: payload.iterationNo,
      step_order: payload.stepOrder,
      tool_name: payload.toolName,
      input_summary: payload.inputSummary,
      output_summary: payload.outputSummary,
      duration_ms: payload.durationMs,
      candidate_count_before: payload.before,
      candidate_count_after: payload.after,
    });
  };

  const finalizeRun = async (payload: {
    statusScope: string[];
    finalCandidateCount: number;
    endReason: string;
  }): Promise<void> => {
    const updatePayload = {
      status_scope: payload.statusScope,
      iteration_count: state.iteration,
      tool_call_count: state.toolCalls,
      final_candidate_count: payload.finalCandidateCount,
      end_reason: payload.endReason,
      latency_ms: Date.now() - startedAtMs,
    };

    if (runRowCreated) {
      await updateSearchRun(supabase, runId, updatePayload);
      return;
    }

    const fallbackInserted = await insertSearchRun(supabase, {
      id: runId,
      session_id: input.sessionId,
      query_text: userMessage,
      ...updatePayload,
    });
    runRowCreated = fallbackInserted !== null;
  };

  try {
    await emitActivity(input, {
      id: "planning",
      label: "Planning",
      detail: "Checking exact-name and intent signals.",
      status: "running",
    });

    let exactMatches: Awaited<ReturnType<typeof searchExactName>> = [];
    const exactBestByCompany = new Map<string, Awaited<ReturnType<typeof searchExactName>>[number]>();

    for (let exactIndex = 0; exactIndex < exactNameInputs.length; exactIndex += 1) {
      const candidateText = exactNameInputs[exactIndex];
      if (!candidateText) {
        continue;
      }

      const exactStart = Date.now();
      const beforeCount = exactBestByCompany.size;
      state.toolCalls += 1;

      try {
        const rows = await searchExactName(supabase, {
          queryText: candidateText,
          statuses: ["startup"],
          limit: 5,
        });

        for (const row of rows) {
          const current = exactBestByCompany.get(row.companyId);
          if (!current || row.nameScore > current.nameScore) {
            exactBestByCompany.set(row.companyId, row);
          }
        }

        await logStep({
          iterationNo: 0,
          stepOrder: 1 + exactIndex,
          toolName: "supabase.rpc.search_exact_name_v1",
          inputSummary: {
            rpcFunction: "search_exact_name_v1",
            rpcArgs: {
              p_query_text: candidateText,
              p_statuses: ["startup"],
              p_limit: 5,
            },
            extractedCandidateIndex: exactIndex,
          },
          outputSummary: {
            count: rows.length,
            topScore: rows[0]?.nameScore ?? 0,
            topRows: rows.slice(0, 5),
          },
          durationMs: Date.now() - exactStart,
          before: beforeCount,
          after: exactBestByCompany.size,
        });
      } catch (error) {
        await logStep({
          iterationNo: 0,
          stepOrder: 1 + exactIndex,
          toolName: "supabase.rpc.search_exact_name_v1",
          inputSummary: {
            rpcFunction: "search_exact_name_v1",
            rpcArgs: {
              p_query_text: candidateText,
              p_statuses: ["startup"],
              p_limit: 5,
            },
            extractedCandidateIndex: exactIndex,
          },
          outputSummary: {
            error: error instanceof Error ? error.message : "Unknown exact-name search error.",
          },
          durationMs: Date.now() - exactStart,
          before: beforeCount,
          after: exactBestByCompany.size,
        });
      }
    }

    exactMatches = Array.from(exactBestByCompany.values()).sort((a, b) => b.nameScore - a.nameScore);
    await logStep({
      iterationNo: 0,
      stepOrder: 19,
      toolName: "anchor.exact_name_precheck_summary",
      inputSummary: {
        userMessage,
        similarityIntent,
        extractedCandidates: exactNameInputs,
      },
      outputSummary: {
        matchCount: exactMatches.length,
        topMatch: exactMatches[0] ?? null,
      },
      durationMs: 0,
      before: 0,
      after: exactMatches.length,
    });
    if (!exactMatches.length) {
      await emitActivity(input, {
        id: "planning",
        label: "Planning",
        detail: "No direct company-name anchor found; continuing with broader retrieval.",
        status: "running",
      });
    }

    const topExact = exactMatches[0];
    if (topExact && topExact.nameScore >= ANCHOR_MATCH_THRESHOLD) {
      const detailsStart = Date.now();
      let companies: Company[] = [];
      try {
        companies = await getCompaniesByIds(supabase, [topExact.companyId]);
      } catch (error) {
        await logStep({
          iterationNo: 0,
          stepOrder: 20,
          toolName: "supabase.rpc.get_companies_by_ids_v1",
          inputSummary: {
            rpcFunction: "get_companies_by_ids_v1",
            rpcArgs: { p_company_ids: [topExact.companyId] },
          },
          outputSummary: {
            error: error instanceof Error ? error.message : "Unknown exact-match company details RPC error.",
          },
          durationMs: Date.now() - detailsStart,
          before: 1,
          after: 0,
        });
        throw error;
      }
      await logStep({
        iterationNo: 0,
        stepOrder: 20,
        toolName: "supabase.rpc.get_companies_by_ids_v1",
        inputSummary: {
          rpcFunction: "get_companies_by_ids_v1",
          rpcArgs: { p_company_ids: [topExact.companyId] },
        },
        outputSummary: {
          count: companies.length,
          ids: companies.map((company) => company.id),
        },
        durationMs: Date.now() - detailsStart,
        before: 1,
        after: companies.length,
      });
      const company = companies[0];
      if (!company) {
        throw new Error("Exact matched company not found in details lookup.");
      }

      if (similarityIntent) {
        anchorCompany = company;
        await logStep({
          iterationNo: 0,
          stepOrder: 21,
          toolName: "anchor.company_context",
          inputSummary: {
            anchorCompanyId: company.id,
            anchorCompanyName: company.company_name,
            matchScore: topExact.nameScore,
          },
          outputSummary: {
            sectors: company.sectors,
            categories: company.categories,
            businessModels: company.business_models,
            topNiches: company.niches.slice(0, 8),
          },
          durationMs: 0,
          before: 1,
          after: 1,
        });

        await emitActivity(input, {
          id: "planning",
          label: "Planning",
          detail: `Using ${company.company_name} as anchor and expanding to similar companies.`,
          status: "running",
        });
      } else if (topExact.nameScore >= EXACT_SHORT_CIRCUIT_THRESHOLD) {
        finalCandidates = [
          {
            ...toSearchCandidateFromExact(company.id, topExact.nameScore),
            rank: 1,
            confidence: 0.99,
            reason: "Exact company name match.",
          },
        ];
        endReason = "exact_match";

        await emitActivity(input, {
          id: "planning",
          label: "Planning",
          detail: "Exact name match found, returning precise result.",
          status: "completed",
        });
      }
    }

    if (endReason !== "exact_match") {
      const model = openai(env.OPENAI_MODEL);
      const embeddingModel = openai.embedding(env.OPENAI_EMBEDDING_MODEL);

      const candidateMap = new Map<string, SearchCandidate>();

      for (let iteration = 1; iteration <= LOOP_LIMITS.maxIterations; iteration += 1) {
        state.iteration = iteration;

        if (Date.now() - state.startedAtMs > LOOP_LIMITS.maxRuntimeMs || state.toolCalls >= LOOP_LIMITS.maxToolCalls) {
          endReason = "guardrail_hit";
          break;
        }

        await emitActivity(input, {
          id: `planning-${iteration}`,
          label: `Planning Round ${iteration}`,
          detail: "Generating multi-query search plan.",
          status: "running",
        });

        const planStart = Date.now();
        state.toolCalls += 1;
        const plannerPrompt = buildPlannerPrompt({
          userMessage,
          chatSummary: asSummary(input.messages),
          previousCandidateIds: state.priorTopIds,
          taxonomyPrompt: getTaxonomyPrompt(),
          searchableFieldsPrompt: getSearchableFieldsPrompt(),
          anchorCompanyContext: anchorCompany ? buildAnchorContext(anchorCompany) : null,
        });
        let planner: { object: PlannerOutput };
        try {
          planner = await generateObject({
            model,
            schema: plannerSchema,
            system: plannerSystemPrompt,
            prompt: plannerPrompt,
          });
        } catch (error) {
          await logStep({
            iterationNo: iteration,
            stepOrder: 1,
            toolName: "llm.plan_actions",
            inputSummary: {
              provider: "openai",
              model: env.OPENAI_MODEL,
              systemPrompt: truncateText(plannerSystemPrompt),
              prompt: truncateText(plannerPrompt),
            },
            outputSummary: {
              error: error instanceof Error ? error.message : "Unknown planner error.",
            },
            durationMs: Date.now() - planStart,
            before: candidateMap.size,
            after: candidateMap.size,
          });
          throw error;
        }

        finalPlan = normalizeTaxonomy(planner.object as AgentPlan);

        if (anchorCompany && similarityIntent) {
          const anchor = anchorCompany;
          const anchorFallbackQueries = buildAnchorFallbackQueries(anchor);
          const filteredPlannerQueries = finalPlan.queryVariants.filter(
            (query) => !isAnchorPlaceholderQuery(query, anchor.company_name),
          );
          finalPlan.queryVariants = dedupeStrings([...filteredPlannerQueries, ...anchorFallbackQueries]).slice(0, 6);
          if (!finalPlan.queryVariants.length) {
            finalPlan.queryVariants = anchorFallbackQueries.length ? anchorFallbackQueries : [userMessage];
          }
        }

        await logStep({
          iterationNo: iteration,
          stepOrder: 1,
          toolName: "llm.plan_actions",
          inputSummary: {
            provider: "openai",
            model: env.OPENAI_MODEL,
            systemPrompt: truncateText(plannerSystemPrompt),
            prompt: truncateText(plannerPrompt),
          },
          outputSummary: {
            rawResponse: planner.object,
            queryVariants: finalPlan.queryVariants,
            filters: finalPlan.filters,
            intent: finalPlan.intent,
            anchorCompanyId: anchorCompany?.id ?? null,
          },
          durationMs: Date.now() - planStart,
          before: candidateMap.size,
          after: candidateMap.size,
        });

        await emitActivity(input, {
          id: `search-${iteration}`,
          label: `Search Round ${iteration}`,
          detail: `Running ${finalPlan.queryVariants.length} query variants.`,
          status: "running",
        });

        const queries = Array.from(new Set(finalPlan.queryVariants.map((query) => query.trim()).filter(Boolean))).slice(0, 6);
        const excludedAnchorIds = anchorCompany ? [anchorCompany.id] : [];
        const embedStart = Date.now();
        state.toolCalls += 1;
        let embeddings: number[][] = [];
        try {
          const embedResult = await embedMany({
            model: embeddingModel,
            values: queries,
          });
          embeddings = embedResult.embeddings;
        } catch (error) {
          await logStep({
            iterationNo: iteration,
            stepOrder: 2,
            toolName: "llm.embed_query_batch",
            inputSummary: {
              provider: "openai",
              model: env.OPENAI_EMBEDDING_MODEL,
              queries,
            },
            outputSummary: {
              error: error instanceof Error ? error.message : "Unknown embedding error.",
            },
            durationMs: Date.now() - embedStart,
            before: candidateMap.size,
            after: candidateMap.size,
          });
          throw error;
        }

        await logStep({
          iterationNo: iteration,
          stepOrder: 2,
          toolName: "llm.embed_query_batch",
          inputSummary: {
            provider: "openai",
            model: env.OPENAI_EMBEDDING_MODEL,
            queries,
          },
          outputSummary: {
            embeddingCount: embeddings.length,
            vectorDimension: embeddings[0]?.length ?? 0,
          },
          durationMs: Date.now() - embedStart,
          before: candidateMap.size,
          after: candidateMap.size,
        });

        for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
          if (state.toolCalls >= LOOP_LIMITS.maxToolCalls) {
            break;
          }

          const queryText = queries[queryIndex] ?? userMessage;
          const queryEmbedding = embeddings[queryIndex] ?? embeddings[0] ?? [];

          const before = candidateMap.size;

          if (finalPlan.searchPriorityOrder.includes("hybrid") && queryEmbedding.length) {
            const start = Date.now();
            state.toolCalls += 1;
            try {
              const hybridRows = await searchHybrid(supabase, {
                queryText,
                queryEmbedding,
                statuses: finalPlan.filters.statuses,
                limit: 120,
                excludeIds: excludedAnchorIds,
              });
              const filteredHybridRows = hybridRows.filter((row) => row.companyId !== anchorCompany?.id);
              buildCandidateMap(candidateMap, filteredHybridRows.map(toSearchCandidateFromHybrid));
              await logStep({
                iterationNo: iteration,
                stepOrder: 3 + queryIndex,
                toolName: "supabase.rpc.search_companies_hybrid_v1",
                inputSummary: {
                  rpcFunction: "search_companies_hybrid_v1",
                  rpcArgs: {
                    p_query_text: queryText,
                    p_statuses: finalPlan.filters.statuses,
                    p_limit: 120,
                    p_min_semantic: 0.25,
                    p_include_ids: null,
                    p_exclude_ids: excludedAnchorIds,
                  },
                },
                outputSummary: {
                  count: filteredHybridRows.length,
                  topRows: filteredHybridRows.slice(0, 5).map((row) => ({
                    companyId: row.companyId,
                    combinedScore: row.combinedScore,
                    semanticScore: row.semanticScore,
                    keywordScore: row.keywordScore,
                    nicheScore: row.nicheScore,
                  })),
                },
                durationMs: Date.now() - start,
                before,
                after: candidateMap.size,
              });
            } catch (error) {
              await logStep({
                iterationNo: iteration,
                stepOrder: 3 + queryIndex,
                toolName: "supabase.rpc.search_companies_hybrid_v1",
                inputSummary: {
                  rpcFunction: "search_companies_hybrid_v1",
                  rpcArgs: {
                    p_query_text: queryText,
                    p_statuses: finalPlan.filters.statuses,
                    p_limit: 120,
                    p_min_semantic: 0.25,
                    p_include_ids: null,
                    p_exclude_ids: excludedAnchorIds,
                  },
                },
                outputSummary: {
                  error: error instanceof Error ? error.message : "Unknown hybrid RPC error.",
                },
                durationMs: Date.now() - start,
                before,
                after: candidateMap.size,
              });
            }
          }

          if (finalPlan.searchPriorityOrder.includes("keyword")) {
            const start = Date.now();
            state.toolCalls += 1;
            try {
              const keywordRows = await searchKeyword(supabase, {
                queryText,
                statuses: finalPlan.filters.statuses,
                limit: 120,
              });
              const filteredKeywordRows = keywordRows.filter((row) => row.companyId !== anchorCompany?.id);
              buildCandidateMap(candidateMap, filteredKeywordRows.map(toSearchCandidateFromKeyword));
              await logStep({
                iterationNo: iteration,
                stepOrder: 10 + queryIndex,
                toolName: "supabase.rpc.search_companies_keyword_v1",
                inputSummary: {
                  rpcFunction: "search_companies_keyword_v1",
                  rpcArgs: {
                    p_query_text: queryText,
                    p_statuses: finalPlan.filters.statuses,
                    p_limit: 120,
                  },
                },
                outputSummary: {
                  count: filteredKeywordRows.length,
                  topRows: filteredKeywordRows.slice(0, 5).map((row) => ({
                    companyId: row.companyId,
                    combinedScore: row.combinedScore,
                    keywordScore: row.keywordScore,
                    nicheScore: row.nicheScore,
                  })),
                },
                durationMs: Date.now() - start,
                before,
                after: candidateMap.size,
              });
            } catch (error) {
              await logStep({
                iterationNo: iteration,
                stepOrder: 10 + queryIndex,
                toolName: "supabase.rpc.search_companies_keyword_v1",
                inputSummary: {
                  rpcFunction: "search_companies_keyword_v1",
                  rpcArgs: {
                    p_query_text: queryText,
                    p_statuses: finalPlan.filters.statuses,
                    p_limit: 120,
                  },
                },
                outputSummary: {
                  error: error instanceof Error ? error.message : "Unknown keyword RPC error.",
                },
                durationMs: Date.now() - start,
                before,
                after: candidateMap.size,
              });
            }
          }
        }

        if (
          finalPlan.searchPriorityOrder.includes("taxonomy") &&
          (finalPlan.filters.sectors.length || finalPlan.filters.categories.length || finalPlan.filters.businessModels.length)
        ) {
          const start = Date.now();
          state.toolCalls += 1;
          try {
            const taxonomyRows = await searchByTaxonomy(supabase, {
              sectors: finalPlan.filters.sectors,
              categories: finalPlan.filters.categories,
              businessModels: finalPlan.filters.businessModels,
              statuses: finalPlan.filters.statuses,
              limit: 500,
            });

            const filteredTaxonomyRows = taxonomyRows.filter((row) => row.companyId !== anchorCompany?.id);
            buildCandidateMap(candidateMap, filteredTaxonomyRows.map(toSearchCandidateFromTaxonomy));

            await logStep({
              iterationNo: iteration,
              stepOrder: 20,
              toolName: "supabase.rpc.search_companies_by_taxonomy_v1",
              inputSummary: {
                rpcFunction: "search_companies_by_taxonomy_v1",
                rpcArgs: {
                  p_sectors: finalPlan.filters.sectors,
                  p_categories: finalPlan.filters.categories,
                  p_business_models: finalPlan.filters.businessModels,
                  p_statuses: finalPlan.filters.statuses,
                  p_limit: 500,
                },
              },
              outputSummary: {
                count: filteredTaxonomyRows.length,
                topRows: filteredTaxonomyRows.slice(0, 8),
              },
              durationMs: Date.now() - start,
              before: candidateMap.size,
              after: candidateMap.size,
            });
          } catch (error) {
            await logStep({
              iterationNo: iteration,
              stepOrder: 20,
              toolName: "supabase.rpc.search_companies_by_taxonomy_v1",
              inputSummary: {
                rpcFunction: "search_companies_by_taxonomy_v1",
                rpcArgs: {
                  p_sectors: finalPlan.filters.sectors,
                  p_categories: finalPlan.filters.categories,
                  p_business_models: finalPlan.filters.businessModels,
                  p_statuses: finalPlan.filters.statuses,
                  p_limit: 500,
                },
              },
              outputSummary: {
                error: error instanceof Error ? error.message : "Unknown taxonomy RPC error.",
              },
              durationMs: Date.now() - start,
              before: candidateMap.size,
              after: candidateMap.size,
            });
          }
        }

        let ranked = sortCandidates(Array.from(candidateMap.values())).slice(0, 80);
        const detailsStart = Date.now();
        let companyDetails: Company[] = [];
        try {
          companyDetails = await getCompaniesByIds(
            supabase,
            ranked.map((candidate) => candidate.companyId),
          );
        } catch (error) {
          await logStep({
            iterationNo: iteration,
            stepOrder: 25,
            toolName: "supabase.rpc.get_companies_by_ids_v1",
            inputSummary: {
              rpcFunction: "get_companies_by_ids_v1",
              rpcArgs: {
                p_company_ids_count: ranked.length,
                sample_ids: ranked.slice(0, 20).map((candidate) => candidate.companyId),
              },
            },
            outputSummary: {
              error: error instanceof Error ? error.message : "Unknown company details RPC error.",
            },
            durationMs: Date.now() - detailsStart,
            before: ranked.length,
            after: 0,
          });
          throw error;
        }
        await logStep({
          iterationNo: iteration,
          stepOrder: 25,
          toolName: "supabase.rpc.get_companies_by_ids_v1",
          inputSummary: {
            rpcFunction: "get_companies_by_ids_v1",
            rpcArgs: {
              p_company_ids_count: ranked.length,
              sample_ids: ranked.slice(0, 20).map((candidate) => candidate.companyId),
            },
          },
          outputSummary: {
            count: companyDetails.length,
            ids: companyDetails.slice(0, 20).map((company) => company.id),
          },
          durationMs: Date.now() - detailsStart,
          before: ranked.length,
          after: companyDetails.length,
        });
        const companiesById = Object.fromEntries(companyDetails.map((company) => [company.id, company]));

        ranked = filterCandidatesByPlan(ranked, companiesById, finalPlan).slice(0, 40);
        if (anchorCompany) {
          const anchorId = anchorCompany.id;
          ranked = ranked.filter((candidate) => candidate.companyId !== anchorId);
        }

        if (!ranked.length) {
          await logStep({
            iterationNo: iteration,
            stepOrder: 29,
            toolName: "candidate_pool.empty_after_filters",
            inputSummary: {
              anchorCompanyId: anchorCompany?.id ?? null,
              filterCount: finalPlan.queryVariants.length,
            },
            outputSummary: {
              message: "No candidates left after deterministic filters and anchor exclusion.",
            },
            durationMs: 0,
            before: 0,
            after: 0,
          });
          continue;
        }

        const rerankStart = Date.now();
        state.toolCalls += 1;
        const rerankerPrompt = buildRerankerPrompt({
          userMessage,
          plan: finalPlan,
          candidates: ranked,
        });
        let reranked: { object: RerankerOutput };
        try {
          reranked = await generateObject({
            model,
            schema: rerankerSchema,
            system: rerankerSystemPrompt,
            prompt: rerankerPrompt,
          });
        } catch (error) {
          await logStep({
            iterationNo: iteration,
            stepOrder: 30,
            toolName: "llm.rerank_candidates",
            inputSummary: {
              provider: "openai",
              model: env.OPENAI_MODEL,
              systemPrompt: truncateText(rerankerSystemPrompt),
              prompt: truncateText(rerankerPrompt),
              candidateCount: ranked.length,
            },
            outputSummary: {
              error: error instanceof Error ? error.message : "Unknown reranker error.",
            },
            durationMs: Date.now() - rerankStart,
            before: ranked.length,
            after: ranked.length,
          });
          throw error;
        }

        const rerankOrder = new Map(
          reranked.object.perCompany.map((item) => [item.companyId, item]),
        );

        ranked = ranked
          .sort((a, b) => {
            const aIndex = reranked.object.rankedCompanyIds.indexOf(a.companyId);
            const bIndex = reranked.object.rankedCompanyIds.indexOf(b.companyId);
            return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
          })
          .map((candidate, index) => {
            const item = rerankOrder.get(candidate.companyId);
            return {
              ...candidate,
              rank: index + 1,
              confidence: item?.confidence ?? candidate.confidence,
              reason: item?.reason ?? candidate.reason,
              evidenceChips: item?.evidenceChips?.length ? item.evidenceChips : candidate.evidenceChips,
            };
          });

        await logStep({
          iterationNo: iteration,
          stepOrder: 30,
          toolName: "llm.rerank_candidates",
          inputSummary: {
            provider: "openai",
            model: env.OPENAI_MODEL,
            systemPrompt: truncateText(rerankerSystemPrompt),
            prompt: truncateText(rerankerPrompt),
            candidateCount: ranked.length,
          },
          outputSummary: {
            rawResponse: reranked.object,
            confidence: reranked.object.confidence,
          },
          durationMs: Date.now() - rerankStart,
          before: ranked.length,
          after: ranked.length,
        });

        const topIds = ranked.slice(0, 5).map((candidate) => candidate.companyId);
        const topScores = ranked.slice(0, 5).map((candidate) => candidate.combinedScore);

        const criticStart = Date.now();
        state.toolCalls += 1;
        const criticPrompt = buildCriticPrompt({
          userMessage,
          iteration,
          candidateCount: ranked.length,
          topScores,
          currentConfidence: reranked.object.confidence,
          previousTopIds: state.priorTopIds,
          currentTopIds: topIds,
        });
        let critic: { object: CriticOutput };
        try {
          critic = await generateObject({
            model,
            schema: criticSchema,
            system: criticSystemPrompt,
            prompt: criticPrompt,
          });
        } catch (error) {
          await logStep({
            iterationNo: iteration,
            stepOrder: 40,
            toolName: "llm.critic_continue_or_stop",
            inputSummary: {
              provider: "openai",
              model: env.OPENAI_MODEL,
              systemPrompt: truncateText(criticSystemPrompt),
              prompt: truncateText(criticPrompt),
            },
            outputSummary: {
              error: error instanceof Error ? error.message : "Unknown critic error.",
            },
            durationMs: Date.now() - criticStart,
            before: ranked.length,
            after: ranked.length,
          });
          throw error;
        }

        await logStep({
          iterationNo: iteration,
          stepOrder: 40,
          toolName: "llm.critic_continue_or_stop",
          inputSummary: {
            provider: "openai",
            model: env.OPENAI_MODEL,
            systemPrompt: truncateText(criticSystemPrompt),
            prompt: truncateText(criticPrompt),
          },
          outputSummary: {
            rawResponse: critic.object,
            topIds,
            confidence: reranked.object.confidence,
            candidateCount: ranked.length,
          },
          durationMs: Date.now() - criticStart,
          before: ranked.length,
          after: ranked.length,
        });

        finalCandidates = ranked;
        const convergedNow = converged(state.priorTopIds, topIds);
        state.priorTopIds = topIds;

        await emitActivity(input, {
          id: `iteration-${iteration}`,
          label: `Iteration ${iteration}`,
          detail: `Evaluated ${ranked.length} candidates with confidence ${reranked.object.confidence.toFixed(2)}.`,
          status: "completed",
        });

        if (critic.object.decision === "stop" && reranked.object.confidence >= 0.74) {
          endReason = "confidence_met";
          break;
        }

        if (convergedNow) {
          endReason = "converged";
          break;
        }

        if (critic.object.decision === "continue" && critic.object.newQueryVariants.length) {
          finalPlan.queryVariants = Array.from(
            new Set([...finalPlan.queryVariants, ...critic.object.newQueryVariants]),
          ).slice(0, 8);
        }

        state.previousBestScore = Math.max(state.previousBestScore, topScores[0] ?? 0);
      }
    }

    if (!finalCandidates.length) {
      const content = "I could not find a confident match in the current company dataset. Try adding sector, category, or a specific company name.";
      const telemetry = {
        runId,
        iterationCount: state.iteration,
        toolCallCount: state.toolCalls,
        endReason,
      };

      await finalizeRun({
        statusScope: finalPlan.filters.statuses,
        finalCandidateCount: 0,
        endReason,
      });

      return {
        content,
        references: [],
        companiesById: {},
        telemetry,
      };
    }

    const anchorId = anchorCompany?.id ?? null;
    const filteredFinalCandidates = anchorId
      ? finalCandidates.filter((candidate) => candidate.companyId !== anchorId)
      : finalCandidates;
    const finalTop = filteredFinalCandidates.slice(0, Math.max(1, finalPlan.targetResultCount));
    if (!finalTop.length) {
      const content = anchorCompany
        ? `I found ${anchorCompany.company_name} as the anchor company, but could not find strong similar companies in the current dataset.`
        : "I could not find a confident match in the current company dataset. Try adding sector, category, or a specific company name.";

      await finalizeRun({
        statusScope: finalPlan.filters.statuses,
        finalCandidateCount: 0,
        endReason,
      });

      return {
        content,
        references: [],
        companiesById: {},
        telemetry: {
          runId,
          iterationCount: state.iteration,
          toolCallCount: state.toolCalls,
          endReason,
        },
      };
    }
    const finalTopIds = finalTop.map((candidate) => candidate.companyId);
    const finalDetailsStart = Date.now();
    let finalCompanies: Company[] = [];
    try {
      finalCompanies = await getCompaniesByIds(supabase, finalTopIds);
    } catch (error) {
      await logStep({
        iterationNo: state.iteration,
        stepOrder: 49,
        toolName: "supabase.rpc.get_companies_by_ids_v1",
        inputSummary: {
          rpcFunction: "get_companies_by_ids_v1",
          rpcArgs: { p_company_ids: finalTopIds },
        },
        outputSummary: {
          error: error instanceof Error ? error.message : "Unknown final company details RPC error.",
        },
        durationMs: Date.now() - finalDetailsStart,
        before: finalTopIds.length,
        after: 0,
      });
      throw error;
    }
    await logStep({
      iterationNo: state.iteration,
      stepOrder: 49,
      toolName: "supabase.rpc.get_companies_by_ids_v1",
      inputSummary: {
        rpcFunction: "get_companies_by_ids_v1",
        rpcArgs: { p_company_ids: finalTopIds },
      },
      outputSummary: {
        count: finalCompanies.length,
        ids: finalCompanies.map((company) => company.id),
      },
      durationMs: Date.now() - finalDetailsStart,
      before: finalTopIds.length,
      after: finalCompanies.length,
    });
    const finalCompanyMap = Object.fromEntries(finalCompanies.map((company) => [company.id, company]));

    const summaryStart = Date.now();
    const summaryPrompt = `Write a concise 2-3 sentence summary for this company search request: ${userMessage}. Mention overall fit and confidence without listing every result.`;
    state.toolCalls += 1;
    let summaryResult: { text: string };
    try {
      summaryResult = await generateText({
        model: openai(env.OPENAI_MODEL),
        prompt: summaryPrompt,
      });
    } catch (error) {
      await logStep({
        iterationNo: state.iteration,
        stepOrder: 50,
        toolName: "llm.final_summary",
        inputSummary: {
          provider: "openai",
          model: env.OPENAI_MODEL,
          prompt: truncateText(summaryPrompt),
        },
        outputSummary: {
          error: error instanceof Error ? error.message : "Unknown summary generation error.",
        },
        durationMs: Date.now() - summaryStart,
        before: finalTop.length,
        after: finalTop.length,
      });
      throw error;
    }

    await logStep({
      iterationNo: state.iteration,
      stepOrder: 50,
      toolName: "llm.final_summary",
      inputSummary: {
        provider: "openai",
        model: env.OPENAI_MODEL,
        prompt: truncateText(summaryPrompt),
      },
      outputSummary: {
        text: truncateText(summaryResult.text, 3000),
      },
      durationMs: Date.now() - summaryStart,
      before: finalTop.length,
      after: finalTop.length,
    });

    if (input.onPartialText) {
      await input.onPartialText(summaryResult.text.slice(0, 140));
    }

    const references = finalTop
      .map((candidate) => {
        const company = finalCompanyMap[candidate.companyId];
        if (!company) {
          return null;
        }

        const inlineDescription = company.description ?? company.product_description ?? candidate.reason;

        return {
          companyId: company.id,
          companyName: company.company_name,
          reason: inlineDescription,
          inlineDescription,
          evidenceChips: Array.from(
            new Set([
              ...(anchorCompany ? [`Similar to ${anchorCompany.company_name}`] : []),
              ...candidate.evidenceChips,
            ]),
          ).slice(0, 4),
          confidence: Number(candidate.confidence.toFixed(3)),
        };
      })
      .filter((value): value is NonNullable<typeof value> => value !== null);

    await finalizeRun({
      statusScope: finalPlan.filters.statuses,
      finalCandidateCount: references.length,
      endReason,
    });

    await insertSearchRunResults(
      supabase,
      references.map((reference, index) => ({
        run_id: runId,
        company_id: reference.companyId,
        rank: index + 1,
        confidence: reference.confidence,
        evidence: {
          evidenceChips: reference.evidenceChips,
          reason: reference.reason,
        },
      })),
    );

    return {
      content: summaryResult.text,
      references,
      companiesById: finalCompanyMap,
      telemetry: {
        runId,
        iterationCount: state.iteration,
        toolCallCount: state.toolCalls,
        endReason,
      },
    };
  } catch (error) {
    await finalizeRun({
      statusScope: finalPlan.filters.statuses.length ? finalPlan.filters.statuses : ["startup"],
      finalCandidateCount: 0,
      endReason: "error",
    });

    throw error;
  }
}
