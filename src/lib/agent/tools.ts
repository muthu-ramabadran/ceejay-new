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
  preliminaryResults: PreliminaryResult[] | null;
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
    .describe("Use to exclude company IDs from results. Use cases: (1) 'companies like X' - exclude the anchor company, (2) 'more results' - exclude ALL previously returned company IDs to avoid duplicates. DO NOT use for 'filter' requests."),
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
      })
    )
    .min(2)
    .max(4)
    .describe("2-4 options to clarify intent"),
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
      description: `Find a company by exact name. Returns name similarity score (>=0.95 = exact match).
Use when user mentions a specific company name.`,
      inputSchema: exactNameSchema,
      execute: async ({ companyName }: z.infer<typeof exactNameSchema>) => {
        ctx.state.toolCallCount += 1;

        const rows = await searchExactName(ctx.supabase, {
          queryText: companyName,
          statuses: ["startup"],
          limit: 10,
        });

        const candidates = rows.map((row) =>
          buildCandidateFromExact(row.companyId, row.nameScore, row.matchedName)
        );
        mergeCandidates(ctx.state.candidates, candidates);

        return {
          results: rows.map((row) => ({
            companyId: row.companyId,
            companyName: row.matchedName,
            nameScore: row.nameScore,
            isExactMatch: row.nameScore >= 0.95,
          })),
          totalFound: rows.length,
          queryUsed: companyName,
        };
      },
    }),

    search_semantic: tool({
      description: `Semantic search based on meaning. Searches: description, product_description,
problem_solved, target_customer, differentiator, niches.

BEST PRACTICE: Call this 2-3 times with different query phrasings for better coverage.
Example for "voice agents": call with "voice agents", "voice AI assistants", "conversational voice AI"

IMPORTANT: A query like "AI coding agents" may return mixed results. Analyze carefully.

For FILTER requests ("filter to customer support"): DO NOT use excludeCompanyIds with previous results.
Only use excludeCompanyIds for "companies like X" to exclude the anchor company.`,
      inputSchema: semanticSearchSchema,
      execute: async ({ query, searchFocus, excludeCompanyIds }: z.infer<typeof semanticSearchSchema>) => {
        ctx.state.toolCallCount += 1;

        const embedding = await ctx.embedQuery(query);

        const rows = await searchHybrid(ctx.supabase, {
          queryText: query,
          queryEmbedding: embedding,
          statuses: ["startup"],
          excludeIds: excludeCompanyIds,
          limit: 50,
          minSemantic: 0.25,
        });

        const candidates = rows.map(buildCandidateFromHybrid);
        mergeCandidates(ctx.state.candidates, candidates);

        return {
          results: rows.slice(0, 15).map((row) => ({
            companyId: row.companyId,
            matchedFields: row.matchedFields,
            matchedTerms: row.matchedTerms,
            semanticScore: Number(row.semanticScore.toFixed(3)),
            combinedScore: Number(row.combinedScore.toFixed(3)),
          })),
          totalFound: rows.length,
          queryUsed: query,
          searchFocus: searchFocus ?? "broad",
        };
      },
    }),

    search_keyword: tool({
      description: `Exact keyword match. Use for specific technical terms, product names, integrations
that semantic search might miss. Good for disambiguation when semantic returns mixed results.`,
      inputSchema: keywordSearchSchema,
      execute: async ({ keywords }: z.infer<typeof keywordSearchSchema>) => {
        ctx.state.toolCallCount += 1;

        const rows = await searchKeyword(ctx.supabase, {
          queryText: keywords,
          statuses: ["startup"],
          limit: 50,
        });

        const candidates = rows.map(buildCandidateFromKeyword);
        mergeCandidates(ctx.state.candidates, candidates);

        return {
          results: rows.slice(0, 15).map((row) => ({
            companyId: row.companyId,
            matchedTerms: row.matchedTerms,
            keywordScore: Number(row.keywordScore.toFixed(3)),
            combinedScore: Number(row.combinedScore.toFixed(3)),
          })),
          totalFound: rows.length,
          queryUsed: keywords,
        };
      },
    }),

    search_taxonomy: tool({
      description: `Filter by industry vertical, category, and business model.
Use the exact sector/category names from the taxonomy in the system prompt.`,
      inputSchema: taxonomySearchSchema,
      execute: async ({ sectors, categories, businessModels }: z.infer<typeof taxonomySearchSchema>) => {
        ctx.state.toolCallCount += 1;

        const rows = await searchByTaxonomy(ctx.supabase, {
          sectors: sectors ?? [],
          categories: categories ?? [],
          businessModels: businessModels ?? [],
          statuses: ["startup"],
          limit: 100,
        });

        const candidates = rows.map(buildCandidateFromTaxonomy);
        mergeCandidates(ctx.state.candidates, candidates);

        return {
          results: rows.slice(0, 20).map((row) => ({
            companyId: row.companyId,
            sectorHits: row.sectorHits,
            categoryHits: row.categoryHits,
            modelHits: row.modelHits,
            tagScore: Number(row.tagScore.toFixed(3)),
          })),
          totalFound: rows.length,
          filtersUsed: { sectors, categories, businessModels },
        };
      },
    }),

    clarify_with_user: tool({
      description: `IMPORTANT: Ask the user to clarify their intent when query is ambiguous.

MUST use this when:
- Query is "AI agents", "AI coding agents", "coding agents", or similar
- After get_company_details, results include BOTH coding assistants (tools that write code) AND agent frameworks (tools to build agents)
- Example: If results contain both "Charlie Labs" (AI coding assistant) and "CrewAI" (agent framework), MUST clarify

Good clarification options for "AI coding agents":
- "AI coding assistants" - Tools that help developers write code (like Cursor, GitHub Copilot)
- "AI agent frameworks" - Infrastructure to build and deploy AI agents (like CrewAI, LangChain)

Do NOT skip this for genuinely ambiguous queries just because you found results.`,
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
          return {
            status: "answered",
            userSelection: selection,
            message: `User selected: "${selection}". Continue searching based on this choice.`,
          };
        }

        // This will cause the agent to pause - the orchestrator handles this specially
        return {
          status: "awaiting_user",
          message: "Waiting for user to select an option. The search will resume after they respond.",
        };
      },
    }),

    get_company_details: tool({
      description: `Get full company profiles (up to 25 at a time). Use after search to understand what companies actually do.
Essential for analyzing whether search results match user intent.
Call MULTIPLE TIMES if you need details for more than 25 companies (e.g., for large result sets).`,
      inputSchema: companyDetailsSchema,
      execute: async ({ companyIds }: z.infer<typeof companyDetailsSchema>) => {
        ctx.state.toolCallCount += 1;

        const companies = await getCompaniesByIds(ctx.supabase, companyIds);

        // Update candidate info with company names
        for (const company of companies) {
          const candidate = ctx.state.candidates.get(company.id);
          if (candidate) {
            candidate.companyName = company.company_name;
            candidate.descriptionSnippet = company.description?.slice(0, 200) ?? undefined;
            candidate.matchedNiches = company.niches.slice(0, 5);
          }
        }

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
        };
      },
    }),

    finalize_search: tool({
      description: `Complete the search with ranked results.

PREREQUISITES (must be true before calling):
1. You MUST have called get_company_details
2. Results must be homogeneous - all same type of company
3. For ambiguous queries like "AI coding agents", you MUST have called clarify_with_user first if results are mixed

DO NOT call this if:
- You haven't called get_company_details yet
- Results contain BOTH coding assistants AND agent frameworks (must clarify first)
- You're unsure if results match user intent`,
      inputSchema: finalizeSchema,
      execute: async ({ rankedResults, overallConfidence, summary }: z.infer<typeof finalizeSchema>) => {
        ctx.state.preliminaryResults = rankedResults.map((result) => ({
          companyId: result.companyId,
          confidence: result.confidence,
          reason: result.reason,
          evidenceChips: result.evidenceChips,
        }));

        return {
          status: "finalized",
          resultCount: rankedResults.length,
          overallConfidence,
          summary,
        };
      },
    }),
  };
}

export type SearchTools = ReturnType<typeof createSearchTools>;
