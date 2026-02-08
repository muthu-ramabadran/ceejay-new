import companiesSample from "@/lib/mock/companies.sample.json";
import type { Company, Founder, FundingRound } from "@/types/company";

interface RawCompanyRow {
  id: string;
  website_url: string;
  status: string | null;
  company_name: string | null;
  tagline: string | null;
  description: string | null;
  product_description: string | null;
  target_customer: string | null;
  problem_solved: string | null;
  differentiator: string | null;
  logo_url: string | null;
  founded_year: number | null;
  headquarters: string | null;
  careers_page: string | null;
  ats_platform: string | null;
  ats_jobs_url: string | null;
  total_raised: string | null;
  funding_rounds: unknown;
  investors: unknown;
  team_size: string | null;
  founders: unknown;
  sectors: unknown;
  categories: unknown;
  niches: unknown;
  business_models: unknown;
  social_links: unknown;
  recent_news: unknown;
  issues: unknown;
  created_at: string | null;
  updated_at: string | null;
  scraped_at: string | null;
  niches_text: string | null;
  niches_search: string | null;
}

function parseJsonUnknown(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseStringArray(value: unknown): string[] {
  const parsed = parseJsonUnknown(value);

  if (Array.isArray(parsed)) {
    return parsed.filter((item): item is string => typeof item === "string");
  }

  return [];
}

function parseStringRecord(value: unknown): Record<string, string> {
  const parsed = parseJsonUnknown(value);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function parseFounderArray(value: unknown): Founder[] {
  const parsed = parseJsonUnknown(value);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
    .map((item) => ({
      name: typeof item.name === "string" ? item.name : "Unknown",
      role: typeof item.role === "string" ? item.role : "Unknown",
      linkedin:
        typeof item.linkedin === "string"
          ? item.linkedin
          : typeof item.linkedin_url === "string"
            ? item.linkedin_url
            : null,
    }));
}

function parseFundingRounds(value: unknown): FundingRound[] {
  const parsed = parseJsonUnknown(value);

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
    .map((item) => ({
      date: typeof item.date === "string" ? item.date : null,
      type:
        typeof item.type === "string"
          ? item.type
          : typeof item.round_type === "string"
            ? item.round_type
            : null,
      amount: typeof item.amount === "string" ? item.amount : null,
      investors: parseStringArray(item.investors),
    }));
}

function parseIssues(value: unknown): unknown[] {
  const parsed = parseJsonUnknown(value);
  return Array.isArray(parsed) ? parsed : [];
}

function normalizeCompany(row: RawCompanyRow): Company {
  return {
    id: row.id,
    website_url: row.website_url,
    status: row.status ?? "startup",
    company_name: row.company_name ?? "Unknown Company",
    tagline: row.tagline,
    description: row.description,
    product_description: row.product_description,
    target_customer: row.target_customer,
    problem_solved: row.problem_solved,
    differentiator: row.differentiator,
    logo_url: row.logo_url,
    founded_year: row.founded_year,
    headquarters: row.headquarters,
    careers_page: row.careers_page,
    ats_platform: row.ats_platform,
    ats_jobs_url: row.ats_jobs_url,
    total_raised: row.total_raised,
    funding_rounds: parseFundingRounds(row.funding_rounds),
    investors: parseStringArray(row.investors),
    team_size: row.team_size,
    founders: parseFounderArray(row.founders),
    sectors: parseStringArray(row.sectors),
    categories: parseStringArray(row.categories),
    niches: parseStringArray(row.niches),
    business_models: parseStringArray(row.business_models),
    social_links: parseStringRecord(row.social_links),
    recent_news: parseStringArray(row.recent_news),
    issues: parseIssues(row.issues),
    created_at: row.created_at,
    updated_at: row.updated_at,
    scraped_at: row.scraped_at,
    niches_text: row.niches_text,
    niches_search: row.niches_search,
  };
}

const rawRows = companiesSample as RawCompanyRow[];

export const MOCK_COMPANIES: Company[] = rawRows.map(normalizeCompany);

export const MOCK_COMPANY_BY_ID: Record<string, Company> = Object.fromEntries(
  MOCK_COMPANIES.map((company) => [company.id, company]),
);
