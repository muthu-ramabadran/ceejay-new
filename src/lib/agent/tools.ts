import { tool } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  getCompaniesByIds,
  searchByTaxonomy,
  searchExactName,
  searchHybrid,
  searchKeyword,
} from "@/lib/search/rpc";
import type { AgentActivityEventPayload, ClarificationOption } from "@/types/chat";
import type { Company } from "@/types/company";

export interface SearchCandidate {
  companyId: string;
  companyName?: string;
  semanticScore: number;
  keywordScore: number;
  nicheScore: number;
  combinedScore: number;
  exactMatchScore: number;
  matchedFields: string[];
  matchedTerms: string[];
  matchedNiches?: string[];
  descriptionSnippet?: string;
}

export interface PreliminaryResult {
  companyId: string;
  confidence: number;
  reason: string;
  evidenceChips: string[];
}

export interface SearchAgentState {
  candidates: Map<string, SearchCandidate>;
  anchorCompany: Company | null;
  toolCallCount: number;
  retrievalQueryLog: string[];
  enforceQueryVariation: boolean;
  hasHighConfidenceExactMatch: boolean;
  preliminaryResults: PreliminaryResult[] | null;
  targetResultCount: number;
  defaultExcludeCompanyIds: string[];
  constrainToCompanyIds: string[] | null;
  companyDetailsFetchedCount: number;
  requireClarificationBeforeFinalize: boolean;
  clarificationSatisfied: boolean;
  clarificationPending: {
    question: string;
    options: ClarificationOption[];
  } | null;
  clarificationResponse: string | null;
}

export interface ToolContext {
  supabase: SupabaseClient;
  embedQuery: (text: string) => Promise<number[]>;
  state: SearchAgentState;
  onActivity?: (event: AgentActivityEventPayload) => Promise<void> | void;
  onClarificationRequest?: (data: { question: string; options: ClarificationOption[] }) => void;
}

function buildCandidateFromExact(
  companyId: string,
  score: number,
  matchedName: string
): SearchCandidate {
  return {
    companyId,
    companyName: matchedName,
    semanticScore: 0,
    keywordScore: 0,
    nicheScore: 0,
    combinedScore: score,
    exactMatchScore: score,
    matchedFields: ["company_name"],
    matchedTerms: [],
  };
}

function buildCandidateFromHybrid(
  row: Awaited<ReturnType<typeof searchHybrid>>[number]
): SearchCandidate {
  return {
    companyId: row.companyId,
    semanticScore: row.semanticScore,
    keywordScore: row.keywordScore,
    nicheScore: row.nicheScore,
    combinedScore: row.combinedScore,
    exactMatchScore: 0,
    matchedFields: row.matchedFields,
    matchedTerms: row.matchedTerms,
  };
}

function buildCandidateFromKeyword(
  row: Awaited<ReturnType<typeof searchKeyword>>[number]
): SearchCandidate {
  return {
    companyId: row.companyId,
    semanticScore: 0,
    keywordScore: row.keywordScore,
    nicheScore: row.nicheScore,
    combinedScore: row.combinedScore,
    exactMatchScore: 0,
    matchedFields: ["keyword"],
    matchedTerms: row.matchedTerms,
  };
}

function buildCandidateFromTaxonomy(
  row: Awaited<ReturnType<typeof searchByTaxonomy>>[number]
): SearchCandidate {
  return {
    companyId: row.companyId,
    semanticScore: 0,
    keywordScore: 0,
    nicheScore: 0,
    combinedScore: row.tagScore,
    exactMatchScore: 0,
    matchedFields: ["taxonomy"],
    matchedTerms: [],
  };
}

function mergeCandidates(
  existing: Map<string, SearchCandidate>,
  incoming: SearchCandidate[]
): void {
  for (const candidate of incoming) {
    const current = existing.get(candidate.companyId);
    if (!current) {
      existing.set(candidate.companyId, candidate);
      continue;
    }

    existing.set(candidate.companyId, {
      ...current,
      companyName: current.companyName ?? candidate.companyName,
      semanticScore: Math.max(current.semanticScore, candidate.semanticScore),
      keywordScore: Math.max(current.keywordScore, candidate.keywordScore),
      nicheScore: Math.max(current.nicheScore, candidate.nicheScore),
      exactMatchScore: Math.max(current.exactMatchScore, candidate.exactMatchScore),
      combinedScore: Math.max(current.combinedScore, candidate.combinedScore),
      matchedFields: Array.from(new Set([...current.matchedFields, ...candidate.matchedFields])),
      matchedTerms: Array.from(new Set([...current.matchedTerms, ...candidate.matchedTerms])),
      matchedNiches: Array.from(new Set([
        ...(current.matchedNiches ?? []),
        ...(candidate.matchedNiches ?? []),
      ])),
    });
  }
}

function dedupeCompanyIds(companyIds: string[]): string[] {
  return Array.from(new Set(companyIds.filter(Boolean)));
}

function applyCompanyIdConstraints(
  companyIds: string[],
  state: SearchAgentState
): string[] {
  const constrainedIds = dedupeCompanyIds(companyIds);
  const excludeSet = new Set(state.defaultExcludeCompanyIds);
  const includeSet = state.constrainToCompanyIds ? new Set(state.constrainToCompanyIds) : null;

  return constrainedIds.filter((companyId) => {
    if (excludeSet.has(companyId)) {
      return false;
    }
    if (includeSet && !includeSet.has(companyId)) {
      return false;
    }
    return true;
  });
}

function effectiveSearchLimit(targetResultCount: number): number {
  return Math.min(200, Math.max(60, targetResultCount * 4));
}

function normalizeQueryForLog(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function recordRetrievalQuery(state: SearchAgentState, query: string): void {
  const normalized = normalizeQueryForLog(query);
  if (normalized) {
    state.retrievalQueryLog.push(normalized);
  }
}

// Input schemas for tools
const exactNameSchema = z.object({
  companyName: z.string().describe("The company name to search for"),
});

const semanticSearchSchema = z.object({
  query: z.string().describe("Natural language query"),
  searchFocus: z
    .enum(["broad", "product", "problem", "capability"])
    .optional()
    .describe(
      "Optional focus: 'product' emphasizes product_description, 'problem' emphasizes problem_solved, 'capability' emphasizes niches"
    ),
  excludeCompanyIds: z
    .array(z.string())
    .optional()
    .describe("Optional additional company IDs to exclude from this semantic search."),
});

const keywordSearchSchema = z.object({
  keywords: z.string().describe("Keywords to search for"),
});

const taxonomySearchSchema = z.object({
  sectors: z
    .array(z.string())
    .optional()
    .describe("e.g., ['Developer Tools', 'Enterprise Software']"),
  categories: z
    .array(z.string())
    .optional()
    .describe("e.g., ['AI Development Tools', 'Testing & QA']"),
  businessModels: z
    .array(z.string())
    .optional()
    .describe("e.g., ['SaaS', 'API-First']"),
});

const clarifySchema = z.object({
  question: z.string().describe("Clear question for the user"),
  options: z
    .array(
      z.object({
        label: z.string(),
        description: z.string(),
        selection: z
          .string()
          .min(4)
          .max(220)
          .describe("Concrete intent text to use when this option is selected."),
      })
    )
    .min(2)
    .max(4)
    .describe("2-4 concrete options to clarify intent (never abstract modes)"),
});

const companyDetailsSchema = z.object({
  companyIds: z
    .array(z.string())
    .max(25)
    .describe("Company IDs to get details for (up to 25 at a time)"),
});

const finalizeSchema = z.object({
  rankedResults: z
    .array(
      z.object({
        companyId: z.string(),
        confidence: z.number().min(0).max(1),
        reason: z
          .string()
          .describe("Why this company matches - be specific about product/capability"),
        evidenceChips: z.array(z.string()).max(4),
      })
    )
    .min(1)
    .max(50)
    .describe("Ranked list of company results (return more when user asks for more)"),
  overallConfidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Overall confidence in the results"),
  summary: z.string().describe("2-3 sentence summary explaining what was found"),
});

export function createSearchTools(ctx: ToolContext) {
  return {
    search_exact_name: tool({
      description: "Find a company by exact name using fuzzy + trigram matching.",
      inputSchema: exactNameSchema,
      execute: async ({ companyName }: z.infer<typeof exactNameSchema>) => {
        ctx.state.toolCallCount += 1;
        recordRetrievalQuery(ctx.state, companyName);
        const candidateCountBefore = ctx.state.candidates.size;

        const rows = await searchExactName(ctx.supabase, {
          queryText: companyName,
          statuses: ["startup"],
          limit: 10,
        });

        const constrainedRows = rows.filter((row) =>
          applyCompanyIdConstraints([row.companyId], ctx.state).length > 0
        );
        if (constrainedRows.some((row) => row.nameScore >= 0.95)) {
          ctx.state.hasHighConfidenceExactMatch = true;
        }

        const candidates = constrainedRows.map((row) =>
          buildCandidateFromExact(row.companyId, row.nameScore, row.matchedName)
        );
        mergeCandidates(ctx.state.candidates, candidates);
        const candidateCountAfter = ctx.state.candidates.size;

        return {
          results: constrainedRows.map((row) => ({
            companyId: row.companyId,
            companyName: row.matchedName,
            nameScore: row.nameScore,
            isExactMatch: row.nameScore >= 0.95,
          })),
          totalFound: constrainedRows.length,
          queryUsed: companyName,
          candidateCountBefore,
          candidateCountAfter,
        };
      },
    }),

    search_semantic: tool({
      description: "Semantic retrieval across company profile fields (description/product/problem/customer/niches).",
      inputSchema: semanticSearchSchema,
      execute: async ({ query, searchFocus, excludeCompanyIds }: z.infer<typeof semanticSearchSchema>) => {
        ctx.state.toolCallCount += 1;
        recordRetrievalQuery(ctx.state, query);
        const candidateCountBefore = ctx.state.candidates.size;
        const mergedExcludeIds = dedupeCompanyIds([
          ...(excludeCompanyIds ?? []),
          ...ctx.state.defaultExcludeCompanyIds,
        ]);
        const includeIds = ctx.state.constrainToCompanyIds ?? undefined;
        const limit = effectiveSearchLimit(ctx.state.targetResultCount);

        const embedding = await ctx.embedQuery(query);

        const rows = await searchHybrid(ctx.supabase, {
          queryText: query,
          queryEmbedding: embedding,
          statuses: ["startup"],
          includeIds,
          excludeIds: mergedExcludeIds.length ? mergedExcludeIds : undefined,
          limit,
          minSemantic: 0.25,
        });

        const constrainedRows = rows.filter((row) =>
          applyCompanyIdConstraints([row.companyId], ctx.state).length > 0
        );
        const candidates = constrainedRows.map(buildCandidateFromHybrid);
        mergeCandidates(ctx.state.candidates, candidates);
        const candidateCountAfter = ctx.state.candidates.size;
        const previewLimit = Math.max(15, Math.min(60, ctx.state.targetResultCount));

        return {
          results: constrainedRows.slice(0, previewLimit).map((row) => ({
            companyId: row.companyId,
            matchedFields: row.matchedFields,
            matchedTerms: row.matchedTerms,
            semanticScore: Number(row.semanticScore.toFixed(3)),
            combinedScore: Number(row.combinedScore.toFixed(3)),
          })),
          totalFound: constrainedRows.length,
          queryUsed: query,
          searchFocus: searchFocus ?? "broad",
          candidateCountBefore,
          candidateCountAfter,
        };
      },
    }),

    search_keyword: tool({
      description: "Lexical keyword retrieval for exact terminology and disambiguation.",
      inputSchema: keywordSearchSchema,
      execute: async ({ keywords }: z.infer<typeof keywordSearchSchema>) => {
        ctx.state.toolCallCount += 1;
        recordRetrievalQuery(ctx.state, keywords);
        const candidateCountBefore = ctx.state.candidates.size;
        const limit = effectiveSearchLimit(ctx.state.targetResultCount);

        const rows = await searchKeyword(ctx.supabase, {
          queryText: keywords,
          statuses: ["startup"],
          limit,
        });

        const constrainedRows = rows.filter((row) =>
          applyCompanyIdConstraints([row.companyId], ctx.state).length > 0
        );
        const candidates = constrainedRows.map(buildCandidateFromKeyword);
        mergeCandidates(ctx.state.candidates, candidates);
        const candidateCountAfter = ctx.state.candidates.size;
        const previewLimit = Math.max(15, Math.min(60, ctx.state.targetResultCount));

        return {
          results: constrainedRows.slice(0, previewLimit).map((row) => ({
            companyId: row.companyId,
            matchedTerms: row.matchedTerms,
            keywordScore: Number(row.keywordScore.toFixed(3)),
            combinedScore: Number(row.combinedScore.toFixed(3)),
          })),
          totalFound: constrainedRows.length,
          queryUsed: keywords,
          candidateCountBefore,
          candidateCountAfter,
        };
      },
    }),

    search_taxonomy: tool({
      description: "Taxonomy filter using sector/category/business model labels.",
      inputSchema: taxonomySearchSchema,
      execute: async ({ sectors, categories, businessModels }: z.infer<typeof taxonomySearchSchema>) => {
        ctx.state.toolCallCount += 1;
        const taxonomySignature = [
          "taxonomy",
          ...(sectors ?? []),
          ...(categories ?? []),
          ...(businessModels ?? []),
        ].join("|");
        recordRetrievalQuery(ctx.state, taxonomySignature);
        const candidateCountBefore = ctx.state.candidates.size;
        const limit = effectiveSearchLimit(ctx.state.targetResultCount);

        const rows = await searchByTaxonomy(ctx.supabase, {
          sectors: sectors ?? [],
          categories: categories ?? [],
          businessModels: businessModels ?? [],
          statuses: ["startup"],
          limit,
        });

        const constrainedRows = rows.filter((row) =>
          applyCompanyIdConstraints([row.companyId], ctx.state).length > 0
        );
        const candidates = constrainedRows.map(buildCandidateFromTaxonomy);
        mergeCandidates(ctx.state.candidates, candidates);
        const candidateCountAfter = ctx.state.candidates.size;
        const previewLimit = Math.max(20, Math.min(80, ctx.state.targetResultCount * 2));

        return {
          results: constrainedRows.slice(0, previewLimit).map((row) => ({
            companyId: row.companyId,
            sectorHits: row.sectorHits,
            categoryHits: row.categoryHits,
            modelHits: row.modelHits,
            tagScore: Number(row.tagScore.toFixed(3)),
          })),
          totalFound: constrainedRows.length,
          filtersUsed: { sectors, categories, businessModels },
          candidateCountBefore,
          candidateCountAfter,
        };
      },
    }),

    clarify_with_user: tool({
      description: "Ask the user to choose intent when results are split across multiple plausible interpretations.",
      inputSchema: clarifySchema,
      execute: async ({ question, options }: z.infer<typeof clarifySchema>) => {
        ctx.state.clarificationPending = { question, options };

        if (ctx.onClarificationRequest) {
          ctx.onClarificationRequest({ question, options });
        }

        // If we already have a response (from resume), return it
        if (ctx.state.clarificationResponse) {
          const selection = ctx.state.clarificationResponse;
          ctx.state.clarificationResponse = null;
          ctx.state.clarificationPending = null;
          ctx.state.clarificationSatisfied = true;
          return {
            status: "answered",
            userSelection: selection,
            message: `User selected: "${selection}". Continue searching based on this choice.`,
            candidateCountBefore: ctx.state.candidates.size,
            candidateCountAfter: ctx.state.candidates.size,
          };
        }

        // This will cause the agent to pause - the orchestrator handles this specially
        return {
          status: "awaiting_user",
          message: "Waiting for user to select an option. The search will resume after they respond.",
          candidateCountBefore: ctx.state.candidates.size,
          candidateCountAfter: ctx.state.candidates.size,
        };
      },
    }),

    get_company_details: tool({
      description: "Fetch full company profiles for validation and ranking. Use multiple calls for large sets.",
      inputSchema: companyDetailsSchema,
      execute: async ({ companyIds }: z.infer<typeof companyDetailsSchema>) => {
        ctx.state.toolCallCount += 1;
        const candidateCountBefore = ctx.state.candidates.size;
        const constrainedIds = applyCompanyIdConstraints(companyIds, ctx.state).slice(0, 25);

        const companies = await getCompaniesByIds(ctx.supabase, constrainedIds);

        // Update candidate info with company names
        for (const company of companies) {
          const candidate = ctx.state.candidates.get(company.id);
          if (candidate) {
            candidate.companyName = company.company_name;
            candidate.descriptionSnippet = company.description?.slice(0, 200) ?? undefined;
            candidate.matchedNiches = company.niches.slice(0, 5);
          }
        }
        if (companies.length > 0) {
          ctx.state.companyDetailsFetchedCount += 1;
        }
        const candidateCountAfter = ctx.state.candidates.size;

        return {
          companies: companies.map((company) => ({
            id: company.id,
            company_name: company.company_name,
            description: company.description,
            product_description: company.product_description?.slice(0, 500),
            problem_solved: company.problem_solved,
            target_customer: company.target_customer,
            differentiator: company.differentiator,
            niches: company.niches,
            sectors: company.sectors,
            categories: company.categories,
            business_models: company.business_models,
          })),
          candidateCountBefore,
          candidateCountAfter,
        };
      },
    }),

    finalize_search: tool({
      description: "Finalize ranked companies after validation. Must follow active constraints and target count.",
      inputSchema: finalizeSchema,
      execute: async ({ rankedResults, overallConfidence, summary }: z.infer<typeof finalizeSchema>) => {
        const candidateCountBefore = ctx.state.candidates.size;
        const uniqueRetrievalQueryCount = new Set(ctx.state.retrievalQueryLog).size;
        if (ctx.state.companyDetailsFetchedCount <= 0) {
          return {
            status: "rejected",
            message: "Call get_company_details before finalize_search.",
            resultCount: 0,
            candidateCountBefore,
            candidateCountAfter: candidateCountBefore,
          };
        }

        if (ctx.state.requireClarificationBeforeFinalize && !ctx.state.clarificationSatisfied) {
          return {
            status: "rejected",
            message: "Clarification required before finalize_search for this query.",
            resultCount: 0,
            candidateCountBefore,
            candidateCountAfter: candidateCountBefore,
          };
        }

        if (
          ctx.state.enforceQueryVariation
          && !ctx.state.hasHighConfidenceExactMatch
          && uniqueRetrievalQueryCount < 2
        ) {
          return {
            status: "rejected",
            message: "Run at least one additional distinct search query variant before finalize_search.",
            resultCount: 0,
            candidateCountBefore,
            candidateCountAfter: candidateCountBefore,
          };
        }

        const constrainedResults = rankedResults
          .filter((result) => applyCompanyIdConstraints([result.companyId], ctx.state).length > 0)
          .filter((result, index, all) => all.findIndex((entry) => entry.companyId === result.companyId) === index)
          .slice(0, 50);

        if (!constrainedResults.length) {
          return {
            status: "rejected",
            message: "No results remain after applying request constraints.",
            resultCount: 0,
            candidateCountBefore,
            candidateCountAfter: candidateCountBefore,
          };
        }

        ctx.state.preliminaryResults = constrainedResults.map((result) => ({
          companyId: result.companyId,
          confidence: result.confidence,
          reason: result.reason,
          evidenceChips: result.evidenceChips,
        }));

        return {
          status: "finalized",
          resultCount: constrainedResults.length,
          overallConfidence,
          summary,
          candidateCountBefore,
          candidateCountAfter: ctx.state.candidates.size,
        };
      },
    }),
  };
}

export type SearchTools = ReturnType<typeof createSearchTools>;
