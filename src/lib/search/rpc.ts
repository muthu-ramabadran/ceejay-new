import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizeCompanyRow } from "@/lib/search/normalize";
import type { Company } from "@/types/company";

export interface ExactNameResult {
  companyId: string;
  nameScore: number;
  matchedName: string;
}

export interface HybridResult {
  companyId: string;
  semanticScore: number;
  keywordScore: number;
  nicheScore: number;
  combinedScore: number;
  matchedFields: string[];
  matchedTerms: string[];
}

export interface KeywordResult {
  companyId: string;
  keywordScore: number;
  nicheScore: number;
  combinedScore: number;
  matchedTerms: string[];
}

export interface TaxonomyResult {
  companyId: string;
  sectorHits: number;
  categoryHits: number;
  modelHits: number;
  tagScore: number;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  return [];
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.map((value) => Number(value).toFixed(8)).join(",")}]`;
}

async function runRpc<T>(client: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T[]> {
  const { data, error } = await client.rpc(fn, args);

  if (error) {
    const hint = error.message.includes("structure of query does not match function result type")
      ? " Apply Supabase migration 0002_rpc_type_fixes.sql."
      : "";
    throw new Error(`${fn} failed: ${error.message}${hint}`);
  }

  return (data as T[] | null) ?? [];
}

export async function searchExactName(
  client: SupabaseClient,
  params: {
    queryText: string;
    statuses: string[];
    limit?: number;
  },
): Promise<ExactNameResult[]> {
  const rows = await runRpc<Record<string, unknown>>(client, "search_exact_name_v1", {
    p_query_text: params.queryText,
    p_statuses: params.statuses,
    p_limit: params.limit ?? 10,
  });

  return rows.map((row) => ({
    companyId: String(row.company_id ?? ""),
    nameScore: asNumber(row.name_score),
    matchedName: String(row.matched_name ?? ""),
  }));
}

export async function searchHybrid(
  client: SupabaseClient,
  params: {
    queryText: string;
    queryEmbedding: number[];
    statuses: string[];
    includeIds?: string[];
    excludeIds?: string[];
    limit?: number;
    minSemantic?: number;
  },
): Promise<HybridResult[]> {
  const rows = await runRpc<Record<string, unknown>>(client, "search_companies_hybrid_v1", {
    p_query_text: params.queryText,
    p_query_embedding: vectorLiteral(params.queryEmbedding),
    p_statuses: params.statuses,
    p_include_ids: params.includeIds ?? null,
    p_exclude_ids: params.excludeIds ?? null,
    p_limit: params.limit ?? 120,
    p_min_semantic: params.minSemantic ?? 0.25,
  });

  return rows.map((row) => ({
    companyId: String(row.company_id ?? ""),
    semanticScore: asNumber(row.semantic_score),
    keywordScore: asNumber(row.keyword_score),
    nicheScore: asNumber(row.niche_score),
    combinedScore: asNumber(row.combined_score),
    matchedFields: asStringArray(row.matched_fields),
    matchedTerms: asStringArray(row.matched_terms),
  }));
}

export async function searchKeyword(
  client: SupabaseClient,
  params: {
    queryText: string;
    statuses: string[];
    limit?: number;
  },
): Promise<KeywordResult[]> {
  const rows = await runRpc<Record<string, unknown>>(client, "search_companies_keyword_v1", {
    p_query_text: params.queryText,
    p_statuses: params.statuses,
    p_limit: params.limit ?? 120,
  });

  return rows.map((row) => ({
    companyId: String(row.company_id ?? ""),
    keywordScore: asNumber(row.keyword_score),
    nicheScore: asNumber(row.niche_score),
    combinedScore: asNumber(row.combined_score),
    matchedTerms: asStringArray(row.matched_terms),
  }));
}

export async function searchByTaxonomy(
  client: SupabaseClient,
  params: {
    sectors?: string[];
    categories?: string[];
    businessModels?: string[];
    statuses: string[];
    limit?: number;
  },
): Promise<TaxonomyResult[]> {
  const rows = await runRpc<Record<string, unknown>>(client, "search_companies_by_taxonomy_v1", {
    p_sectors: params.sectors && params.sectors.length ? params.sectors : null,
    p_categories: params.categories && params.categories.length ? params.categories : null,
    p_business_models: params.businessModels && params.businessModels.length ? params.businessModels : null,
    p_statuses: params.statuses,
    p_limit: params.limit ?? 500,
  });

  return rows.map((row) => ({
    companyId: String(row.company_id ?? ""),
    sectorHits: asNumber(row.sector_hits),
    categoryHits: asNumber(row.category_hits),
    modelHits: asNumber(row.model_hits),
    tagScore: asNumber(row.tag_score),
  }));
}

export async function getCompaniesByIds(client: SupabaseClient, companyIds: string[]): Promise<Company[]> {
  if (!companyIds.length) {
    return [];
  }

  const rows = await runRpc<Record<string, unknown>>(client, "get_companies_by_ids_v1", {
    p_company_ids: companyIds,
  });

  return rows.map((row) => normalizeCompanyRow(row));
}
