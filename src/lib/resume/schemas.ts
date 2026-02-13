import { z } from "zod";

export const resumeProfileSchema = z.object({
  experienceAreas: z.array(
    z.object({
      domain: z.string().describe("e.g. 'lending products', 'cloud infrastructure', 'legal tech'"),
      context: z.string().describe("e.g. 'Built underwriting models for SMB lending at Stripe'"),
      yearsApprox: z.number().describe("Approximate years in this domain"),
    })
  ),
  industriesWorked: z.array(z.string()).describe("e.g. 'Fintech', 'Healthcare', 'Enterprise SaaS'"),
  problemSpaces: z.array(z.string()).describe("e.g. 'fraud detection', 'real-time data pipelines'"),
  productTypes: z.array(z.string()).describe("e.g. 'API platforms', 'B2B SaaS', 'marketplace'"),
  customerSegments: z.array(z.string()).describe("e.g. 'SMBs', 'enterprise', 'developers'"),
  totalYearsExperience: z.number(),
  summary: z.string().describe("2-3 sentence professional summary focused on domain expertise"),
});

export type ResumeProfile = z.infer<typeof resumeProfileSchema>;

export const searchPlanSchema = z.object({
  coreSearches: z.array(
    z.object({
      query: z.string().describe("4-5 word specific search query targeting a niche or problem space"),
      searchType: z.enum(["semantic", "keyword", "taxonomy"]),
      rationale: z.string().describe("Why this search based on the resume"),
    })
  ),
  adjacentSearches: z.array(
    z.object({
      query: z.string().describe("4-5 word query for tangential/adjacent domains"),
      rationale: z.string().describe("Why this adjacent domain is interesting"),
    })
  ),
  taxonomyFilters: z.array(
    z.object({
      sectors: z.array(z.string()).describe("Sector names from the taxonomy"),
      categories: z.array(z.string()).describe("Category names from the taxonomy"),
      rationale: z.string(),
    })
  ),
});

export type SearchPlan = z.infer<typeof searchPlanSchema>;

const companyMatchSchema = z.object({
  companyId: z.string(),
  reason: z.string().describe("Short 10-15 word reason why this company matches"),
});

export const groupedResultsSchema = z.object({
  groups: z.array(
    z.object({
      title: z.string().describe("e.g. 'Lending & Credit Platforms'"),
      description: z.string().describe("Why this group matches the candidate's experience"),
      companyIds: z.array(z.string()),
      companyReasons: z.array(companyMatchSchema).describe("Why each company matches"),
    })
  ),
  feelingLucky: z.object({
    title: z.string().describe("Should be 'Feeling Lucky'"),
    description: z.string().describe("Why these tangential matches might be interesting"),
    companyIds: z.array(z.string()),
    companyReasons: z.array(companyMatchSchema).describe("Why each company is interesting"),
  }),
});

export type GroupedResults = z.infer<typeof groupedResultsSchema>;

/** Helper to convert companyReasons array to a lookup map */
export function reasonsToMap(reasons: Array<{ companyId: string; reason: string }>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const r of reasons) {
    map[r.companyId] = r.reason;
  }
  return map;
}

export type ResumeStreamEvent =
  | { type: "activity"; data: { id: string; label: string; detail: string; status: "running" | "completed" } }
  | { type: "resume_profile"; data: ResumeProfile }
  | { type: "search_progress"; data: { completed: number; total: number; currentQuery: string } }
  | { type: "final_results"; data: { groups: GroupedResults; companiesById: Record<string, unknown> } }
  | { type: "error"; data: { message: string } };
