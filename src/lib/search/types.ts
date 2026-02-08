import type { Company } from "@/types/company";

export interface SearchCandidate {
  companyId: string;
  semanticScore: number;
  keywordScore: number;
  nicheScore: number;
  combinedScore: number;
  exactMatchScore: number;
  matchedFields: string[];
  matchedTerms: string[];
  evidenceChips: string[];
}

export interface RankedCandidate extends SearchCandidate {
  rank: number;
  confidence: number;
  reason: string;
}

export interface AgentFilterPlan {
  statuses: string[];
  sectors: string[];
  categories: string[];
  businessModels: string[];
  niches: string[];
  nicheMode: "boost" | "must_match";
}

export interface AgentPlan {
  intent: "discover" | "narrow" | "compare" | "find_company";
  targetResultCount: number;
  queryVariants: string[];
  searchPriorityOrder: Array<"exact_name" | "hybrid" | "keyword" | "taxonomy">;
  filters: AgentFilterPlan;
  successCriteria: string;
}

export interface SearchLoopLimits {
  maxIterations: number;
  maxToolCalls: number;
  maxRuntimeMs: number;
}

export interface SearchLoopState {
  startedAtMs: number;
  iteration: number;
  toolCalls: number;
  priorTopIds: string[];
  previousBestScore: number;
}

export interface SearchRunTelemetry {
  runId: string;
  iterationCount: number;
  toolCallCount: number;
  endReason: "exact_match" | "confidence_met" | "converged" | "guardrail_hit" | "error";
}

export interface FinalAnswerPayload {
  content: string;
  references: Array<{
    companyId: string;
    companyName: string;
    reason: string;
    inlineDescription: string;
    evidenceChips: string[];
    confidence: number;
  }>;
  companiesById: Record<string, Company>;
  telemetry: SearchRunTelemetry;
}
