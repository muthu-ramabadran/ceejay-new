import type { Company, Founder, FundingRound } from "@/types/company";

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

function parseFounders(value: unknown): Founder[] {
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
      type: typeof item.type === "string" ? item.type : null,
      amount: typeof item.amount === "string" ? item.amount : null,
      investors: parseStringArray(item.investors),
    }));
}

function parseUnknownArray(value: unknown): unknown[] {
  const parsed = parseJsonUnknown(value);
  return Array.isArray(parsed) ? parsed : [];
}

function parseNullableNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function normalizeCompanyRow(row: Record<string, unknown>): Company {
  return {
    id: String(row.id ?? ""),
    website_url: String(row.website_url ?? ""),
    status: String(row.status ?? "startup"),
    company_name: String(row.company_name ?? "Unknown Company"),
    tagline: typeof row.tagline === "string" ? row.tagline : null,
    description: typeof row.description === "string" ? row.description : null,
    product_description: typeof row.product_description === "string" ? row.product_description : null,
    target_customer: typeof row.target_customer === "string" ? row.target_customer : null,
    problem_solved: typeof row.problem_solved === "string" ? row.problem_solved : null,
    differentiator: typeof row.differentiator === "string" ? row.differentiator : null,
    logo_url: typeof row.logo_url === "string" ? row.logo_url : null,
    founded_year: typeof row.founded_year === "number" ? row.founded_year : null,
    headquarters: typeof row.headquarters === "string" ? row.headquarters : null,
    careers_page: typeof row.careers_page === "string" ? row.careers_page : null,
    ats_platform: typeof row.ats_platform === "string" ? row.ats_platform : null,
    ats_jobs_url: typeof row.ats_jobs_url === "string" ? row.ats_jobs_url : null,
    total_raised: typeof row.total_raised === "string" ? row.total_raised : null,
    total_raised_amount: parseNullableNumber(row.total_raised_amount),
    total_raised_currency_code:
      typeof row.total_raised_currency_code === "string" ? row.total_raised_currency_code : null,
    funding_rounds: parseFundingRounds(row.funding_rounds),
    investors: parseStringArray(row.investors),
    team_size: typeof row.team_size === "string" ? row.team_size : null,
    founders: parseFounders(row.founders),
    sectors: parseStringArray(row.sectors),
    categories: parseStringArray(row.categories),
    niches: parseStringArray(row.niches),
    business_models: parseStringArray(row.business_models),
    social_links: parseStringRecord(row.social_links),
    recent_news: parseStringArray(row.recent_news),
    issues: parseUnknownArray(row.issues),
    created_at: typeof row.created_at === "string" ? row.created_at : null,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
    scraped_at: typeof row.scraped_at === "string" ? row.scraped_at : null,
    niches_text: typeof row.niches_text === "string" ? row.niches_text : null,
    niches_search: typeof row.niches_search === "string" ? row.niches_search : null,
  };
}
