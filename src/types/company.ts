export type CompanyStatus = "startup" | "acquired" | "closed" | "ipoed" | string;

export interface Founder {
  name: string;
  role: string;
  linkedin: string | null;
}

export interface FundingRound {
  date: string | null;
  type: string | null;
  amount: string | null;
  investors: string[];
}

export interface Company {
  id: string;
  website_url: string;
  status: CompanyStatus;
  company_name: string;
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
  funding_rounds: FundingRound[];
  investors: string[];
  team_size: string | null;
  founders: Founder[];
  sectors: string[];
  categories: string[];
  niches: string[];
  business_models: string[];
  social_links: Record<string, string>;
  recent_news: string[];
  issues: unknown[];
  created_at: string | null;
  updated_at: string | null;
  scraped_at: string | null;
  niches_text: string | null;
  niches_search: string | null;
}

export interface CompanyReference {
  companyId: string;
  companyName: string;
  reason: string;
  inlineDescription?: string;
  evidenceChips?: string[];
  confidence?: number;
}
