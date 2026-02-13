import { z } from "zod";

export const plannerSchema = z.object({
  intent: z.enum(["discover", "narrow", "compare", "find_company"]),
  targetResultCount: z.number().int().min(1).max(20),
  queryVariants: z.array(z.string().min(2)).min(1).max(6),
  searchPriorityOrder: z
    .array(z.enum(["exact_name", "hybrid", "keyword", "taxonomy"]))
    .min(1)
    .max(4),
  filters: z.object({
    statuses: z.array(z.string()),
    sectors: z.array(z.string()),
    categories: z.array(z.string()),
    businessModels: z.array(z.string()),
    niches: z.array(z.string()),
    nicheMode: z.enum(["boost", "must_match"]),
  }),
  successCriteria: z.string().min(3),
});

export type PlannerOutput = z.infer<typeof plannerSchema>;

export const rerankerSchema = z.object({
  confidence: z.number().min(0).max(1),
  rankedCompanyIds: z.array(z.string()).min(1).max(50),
  perCompany: z.array(
    z.object({
      companyId: z.string(),
      reason: z.string().min(4),
      inlineDescription: z.string().min(4),
      evidenceChips: z.array(z.string().min(2)).max(5),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

export type RerankerOutput = z.infer<typeof rerankerSchema>;

export const criticSchema = z.object({
  decision: z.enum(["continue", "stop"]),
  why: z.string().min(4),
  confidenceTargetMet: z.boolean(),
  shouldExpandQueries: z.boolean(),
  newQueryVariants: z.array(z.string()).max(3),
});

export type CriticOutput = z.infer<typeof criticSchema>;
