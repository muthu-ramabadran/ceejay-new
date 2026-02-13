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

    for (let idx = 0; idx < batchResults.length; idx += 1) {
      const settled = batchResults[idx];
      const query = batch[idx]?.query ?? "";
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
        onProgress?.(completed, totalSearches, source);
      } else {
        onProgress?.(completed, totalSearches, query);
      }
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

const RESUME_GROUPING_TARGET_COUNT = 100;
const RESUME_GROUPING_POOL_LIMIT = 140;

function normalizeGroupedResults(input: {
  grouped: GroupedResults;
  orderedCompanyIds: string[];
  adjacentIds: Set<string>;
  targetCount: number;
}): GroupedResults {
  const availableIds = new Set(input.orderedCompanyIds);
  const usedIds = new Set<string>();
  const reasonById = new Map<string, string>();

  for (const group of input.grouped.groups) {
    for (const reason of group.companyReasons) {
      if (!reasonById.has(reason.companyId) && reason.reason.trim()) {
        reasonById.set(reason.companyId, reason.reason.trim());
      }
    }
  }
  for (const reason of input.grouped.feelingLucky.companyReasons) {
    if (!reasonById.has(reason.companyId) && reason.reason.trim()) {
      reasonById.set(reason.companyId, reason.reason.trim());
    }
  }

  const defaultReason = "Strong match based on your domain experience and role-relevant problem space.";
  const normalizeIds = (ids: string[]): string[] => {
    const deduped: string[] = [];
    for (const id of ids) {
      if (!availableIds.has(id) || usedIds.has(id)) {
        continue;
      }
      usedIds.add(id);
      deduped.push(id);
    }
    return deduped;
  };

  const normalizedGroups: GroupedResults["groups"] = [];
  for (const group of input.grouped.groups) {
    const ids = normalizeIds(group.companyIds);
    if (!ids.length) continue;
    normalizedGroups.push({
      title: group.title,
      description: group.description,
      companyIds: ids,
      companyReasons: ids.map((companyId) => ({
        companyId,
        reason: reasonById.get(companyId) ?? defaultReason,
      })),
    });
  }

  let luckyIds = normalizeIds(input.grouped.feelingLucky.companyIds);

  const desiredTotal = Math.min(input.targetCount, input.orderedCompanyIds.length);
  const currentTotal = normalizedGroups.reduce((sum, group) => sum + group.companyIds.length, 0) + luckyIds.length;

  if (currentTotal < desiredTotal) {
    const fillIds = input.orderedCompanyIds
      .filter((id) => !usedIds.has(id))
      .slice(0, desiredTotal - currentTotal);

    const primaryFill = fillIds.filter((id) => !input.adjacentIds.has(id));
    const luckyFill = fillIds.filter((id) => input.adjacentIds.has(id));

    if (primaryFill.length > 0) {
      for (const id of primaryFill) usedIds.add(id);
      normalizedGroups.push({
        title: "Additional Strong Matches",
        description: "Additional high-relevance matches based on your profile and search ranking.",
        companyIds: primaryFill,
        companyReasons: primaryFill.map((companyId) => ({
          companyId,
          reason: reasonById.get(companyId) ?? defaultReason,
        })),
      });
    }

    if (luckyFill.length > 0) {
      for (const id of luckyFill) usedIds.add(id);
      luckyIds = [...luckyIds, ...luckyFill];
    }
  }

  if (!normalizedGroups.length && input.orderedCompanyIds.length) {
    const fallbackIds = input.orderedCompanyIds.slice(0, Math.min(desiredTotal || 20, input.orderedCompanyIds.length));
    normalizedGroups.push({
      title: "Top Matches",
      description: "Highest ranked companies matching your resume profile.",
      companyIds: fallbackIds,
      companyReasons: fallbackIds.map((companyId) => ({
        companyId,
        reason: reasonById.get(companyId) ?? defaultReason,
      })),
    });
    luckyIds = luckyIds.filter((id) => !fallbackIds.includes(id));
  }

  return {
    groups: normalizedGroups,
    feelingLucky: {
      title: input.grouped.feelingLucky.title || "Feeling Lucky",
      description:
        input.grouped.feelingLucky.description ||
        "Interesting adjacent opportunities related to your experience.",
      companyIds: luckyIds,
      companyReasons: luckyIds.map((companyId) => ({
        companyId,
        reason: reasonById.get(companyId) ?? defaultReason,
      })),
    },
  };
}

export async function fetchAndGroupResults(
  results: Map<string, SearchResult>,
  adjacentIds: Set<string>,
  profile: ResumeProfile
): Promise<{ grouped: GroupedResults; companiesById: Record<string, Company> }> {
  const env = getServerEnv();
  const supabase = getSupabaseServerClient();

  // Keep a broad but bounded candidate pool for grouping quality and prompt size.
  const rankedIds = Array.from(results.values())
    .sort((a, b) => b.score - a.score)
    .map((r) => r.companyId);
  const selectedIds = rankedIds.slice(0, Math.min(RESUME_GROUPING_POOL_LIMIT, rankedIds.length));
  const companies: Company[] = [];

  // Fetch in batches of 50
  for (let i = 0; i < selectedIds.length; i += 50) {
    const batch = selectedIds.slice(i, i + 50);
    const fetched = await getCompaniesByIds(supabase, batch);
    companies.push(...fetched);
  }

  const fetchedById = new Map(companies.map((c) => [c.id, c]));
  const orderedCompanies = selectedIds
    .map((id) => fetchedById.get(id))
    .filter((company): company is Company => Boolean(company));
  const companiesById = Object.fromEntries(orderedCompanies.map((c) => [c.id, c]));

  const profileSummary = [
    `Summary: ${profile.summary}`,
    `Experience areas: ${profile.experienceAreas.map((a) => `${a.domain} (~${a.yearsApprox}y)`).join("; ")}`,
    `Industries: ${profile.industriesWorked.join(", ")}`,
    `Problem spaces: ${profile.problemSpaces.join(", ")}`,
  ].join("\n");

  const companyList = orderedCompanies.map((c) => ({
    id: c.id,
    name: c.company_name,
    description: c.description,
    sectors: c.sectors,
    categories: c.categories,
  }));
  const adjacentInPool = new Set(
    Array.from(adjacentIds).filter((companyId) => Boolean(companiesById[companyId]))
  );
  const groupingTargetCount = Math.min(RESUME_GROUPING_TARGET_COUNT, orderedCompanies.length);

  const result = await generateObject({
    model: openai(env.OPENAI_MODEL),
    schema: groupedResultsSchema,
    prompt: buildGroupingPrompt(profileSummary, companyList, adjacentInPool, groupingTargetCount),
  });

  const normalizedGrouped = normalizeGroupedResults({
    grouped: result.object,
    orderedCompanyIds: selectedIds.filter((companyId) => Boolean(companiesById[companyId])),
    adjacentIds: adjacentInPool,
    targetCount: groupingTargetCount,
  });

  return { grouped: normalizedGrouped, companiesById };
}
