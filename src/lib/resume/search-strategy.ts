import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { embedMany } from "ai";

import { getServerEnv } from "@/lib/env";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { searchHybrid, searchKeyword, searchByTaxonomy, getCompaniesByIds } from "@/lib/search/rpc";
import {
  searchPlanSchema,
  groupedResultsSchema,
  type ResumeProfile,
  type SearchPlan,
  type GroupedResults,
} from "@/lib/resume/schemas";
import { buildSearchPlanPrompt, buildGroupingPrompt } from "@/lib/resume/prompts";
import type { Company } from "@/types/company";

interface SearchResult {
  companyId: string;
  score: number;
  source: string; // which query found it
  isAdjacent: boolean;
}

interface ProgressCallback {
  (completed: number, total: number, currentQuery: string): void;
}

export async function generateSearchPlan(profile: ResumeProfile): Promise<SearchPlan> {
  const env = getServerEnv();

  const profileSummary = [
    `Summary: ${profile.summary}`,
    `Total experience: ${profile.totalYearsExperience} years`,
    `Experience areas: ${profile.experienceAreas.map((a) => `${a.domain} (~${a.yearsApprox}y: ${a.context})`).join("; ")}`,
    `Industries: ${profile.industriesWorked.join(", ")}`,
    `Problem spaces: ${profile.problemSpaces.join(", ")}`,
    `Product types: ${profile.productTypes.join(", ")}`,
    `Customer segments: ${profile.customerSegments.join(", ")}`,
  ].join("\n");

  const result = await generateObject({
    model: openai(env.OPENAI_MODEL),
    schema: searchPlanSchema,
    prompt: buildSearchPlanPrompt(profileSummary, profile.totalYearsExperience),
  });

  return result.object;
}

async function embedQuery(text: string): Promise<number[]> {
  const env = getServerEnv();
  const result = await embedMany({
    model: openai.embedding(env.OPENAI_EMBEDDING_MODEL),
    values: [text],
  });
  return result.embeddings[0];
}

export async function executeSearchPlan(
  plan: SearchPlan,
  onProgress?: ProgressCallback
): Promise<{ results: Map<string, SearchResult>; adjacentIds: Set<string> }> {
  const supabase = getSupabaseServerClient();
  const results = new Map<string, SearchResult>();
  const adjacentIds = new Set<string>();

  const allSearches = [
    ...plan.coreSearches.map((s) => ({ ...s, isAdjacent: false })),
    ...plan.adjacentSearches.map((s) => ({ query: s.query, searchType: "semantic" as const, rationale: s.rationale, isAdjacent: true })),
  ];

  const taxonomySearches = plan.taxonomyFilters;
  const totalSearches = allSearches.length + taxonomySearches.length;
  let completed = 0;

  // Run searches in parallel batches of 4
  const BATCH_SIZE = 4;

  for (let i = 0; i < allSearches.length; i += BATCH_SIZE) {
    const batch = allSearches.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.allSettled(
      batch.map(async (search) => {
        let rows: Array<{ companyId: string; score: number }> = [];

        if (search.searchType === "semantic") {
          const embedding = await embedQuery(search.query);
          const hybridRows = await searchHybrid(supabase, {
            queryText: search.query,
            queryEmbedding: embedding,
            statuses: ["startup"],
            limit: 30,
            minSemantic: 0.2,
          });
          rows = hybridRows.map((r) => ({ companyId: r.companyId, score: r.combinedScore }));
        } else if (search.searchType === "keyword") {
          const keywordRows = await searchKeyword(supabase, {
            queryText: search.query,
            statuses: ["startup"],
            limit: 30,
          });
          rows = keywordRows.map((r) => ({ companyId: r.companyId, score: r.combinedScore }));
        }

        return { rows, source: search.query, isAdjacent: search.isAdjacent };
      })
    );

    for (const settled of batchResults) {
      completed++;
      if (settled.status === "fulfilled") {
        const { rows, source, isAdjacent } = settled.value;
        for (const row of rows) {
          if (isAdjacent) {
            adjacentIds.add(row.companyId);
          }
          const existing = results.get(row.companyId);
          if (!existing || row.score > existing.score) {
            results.set(row.companyId, {
              companyId: row.companyId,
              score: row.score,
              source,
              isAdjacent: isAdjacent && !existing, // only mark as adjacent if not found in core
            });
          }
        }
      }
      onProgress?.(completed, totalSearches, batch[0]?.query ?? "");
    }
  }

  // Run taxonomy searches
  for (const taxSearch of taxonomySearches) {
    try {
      const rows = await searchByTaxonomy(supabase, {
        sectors: taxSearch.sectors,
        categories: taxSearch.categories,
        statuses: ["startup"],
        limit: 50,
      });
      for (const row of rows) {
        const existing = results.get(row.companyId);
        if (!existing || row.tagScore > existing.score) {
          results.set(row.companyId, {
            companyId: row.companyId,
            score: row.tagScore,
            source: `taxonomy: ${(taxSearch.sectors ?? []).join(",")}`,
            isAdjacent: false,
          });
        }
      }
    } catch {
      // Taxonomy search failures are non-fatal
    }
    completed++;
    onProgress?.(completed, totalSearches, `Taxonomy: ${(taxSearch.sectors ?? []).join(", ")}`);
  }

  return { results, adjacentIds };
}

export async function fetchAndGroupResults(
  results: Map<string, SearchResult>,
  adjacentIds: Set<string>,
  profile: ResumeProfile
): Promise<{ grouped: GroupedResults; companiesById: Record<string, Company> }> {
  const env = getServerEnv();
  const supabase = getSupabaseServerClient();

  // Fetch all unique company details
  const allIds = Array.from(results.keys());
  const companies: Company[] = [];

  // Fetch in batches of 50
  for (let i = 0; i < allIds.length; i += 50) {
    const batch = allIds.slice(i, i + 50);
    const fetched = await getCompaniesByIds(supabase, batch);
    companies.push(...fetched);
  }

  const companiesById = Object.fromEntries(companies.map((c) => [c.id, c]));

  const profileSummary = [
    `Summary: ${profile.summary}`,
    `Experience areas: ${profile.experienceAreas.map((a) => `${a.domain} (~${a.yearsApprox}y)`).join("; ")}`,
    `Industries: ${profile.industriesWorked.join(", ")}`,
    `Problem spaces: ${profile.problemSpaces.join(", ")}`,
  ].join("\n");

  const companyList = companies.map((c) => ({
    id: c.id,
    name: c.company_name,
    description: c.description,
    sectors: c.sectors,
    categories: c.categories,
  }));

  const result = await generateObject({
    model: openai(env.OPENAI_MODEL),
    schema: groupedResultsSchema,
    prompt: buildGroupingPrompt(profileSummary, companyList, adjacentIds),
  });

  return { grouped: result.object, companiesById };
}
