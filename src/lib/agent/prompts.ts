import type { AgentPlan, RankedCandidate } from "@/lib/search/types";

export const plannerSystemPrompt = `You are an agentic search planner for startup company discovery.
You must output strictly valid JSON.
Rules:
- Always produce multiple query variants when helpful.
- Default statuses to startup unless user asks otherwise.
- Use sectors/categories/business models only from taxonomy when provided.
- If query appears to be an exact company name, prioritize exact_name in searchPriorityOrder.
- For narrow-down instructions (only/just/exactly), set nicheMode to must_match when applicable.
- Always include all filter keys exactly: statuses, sectors, categories, businessModels, niches, nicheMode.
- Use empty arrays when a filter is not specified.
- If anchor company context is provided, first understand the anchor's business profile and generate similarity queries from its product/problem/niches, not from the company name string alone.
- Prefer query variants that target actual searchable fields (description, product_description, problem_solved, target_customer, differentiator, niches, sectors, categories, business_models).`;

const SEARCHABLE_FIELDS_PROMPT = [
  "Searchable fields in company dataset:",
  "- company_name (exact and fuzzy)",
  "- tagline",
  "- description",
  "- product_description",
  "- target_customer",
  "- problem_solved",
  "- differentiator",
  "- niches",
  "- sectors",
  "- categories",
  "- business_models",
].join("\n");

export function getSearchableFieldsPrompt(): string {
  return SEARCHABLE_FIELDS_PROMPT;
}

export function buildPlannerPrompt(input: {
  userMessage: string;
  chatSummary: string;
  previousCandidateIds: string[];
  taxonomyPrompt: string;
  searchableFieldsPrompt: string;
  anchorCompanyContext?: string | null;
}): string {
  return [
    "User message:",
    input.userMessage,
    "",
    "Conversation context summary:",
    input.chatSummary || "None",
    "",
    `Previous candidate ids: ${input.previousCandidateIds.join(", ") || "None"}`,
    "",
    input.searchableFieldsPrompt,
    "",
    "Allowed taxonomy:",
    input.taxonomyPrompt,
    "",
    input.anchorCompanyContext ? `Anchor company context:\n${input.anchorCompanyContext}\n` : "Anchor company context: None\n",
    "",
    "Return JSON with intent, targetResultCount, queryVariants, searchPriorityOrder, filters, successCriteria.",
    "filters must always include: statuses[], sectors[], categories[], businessModels[], niches[], nicheMode.",
    "If anchor company context exists, queryVariants should mostly use anchor business descriptors and can include at most one name-based variant.",
  ].join("\n");
}

export const rerankerSystemPrompt = `You are ranking company search candidates.
Return strictly valid JSON.
Prioritize precision and intent fit.
If exact name match exists, rank it first with high confidence.`;

export function buildRerankerPrompt(input: {
  userMessage: string;
  plan: AgentPlan;
  candidates: RankedCandidate[];
}): string {
  const candidateBlock = input.candidates
    .slice(0, 30)
    .map((candidate) =>
      JSON.stringify({
        companyId: candidate.companyId,
        combinedScore: candidate.combinedScore,
        semanticScore: candidate.semanticScore,
        keywordScore: candidate.keywordScore,
        nicheScore: candidate.nicheScore,
        evidenceChips: candidate.evidenceChips,
      }),
    )
    .join("\n");

  return [
    `User message: ${input.userMessage}`,
    "",
    `Intent: ${input.plan.intent}`,
    `Target result count: ${input.plan.targetResultCount}`,
    "",
    "Candidates:",
    candidateBlock,
    "",
    "Return JSON: confidence, rankedCompanyIds, perCompany[{companyId,reason,inlineDescription,evidenceChips,confidence}]",
  ].join("\n");
}

export const criticSystemPrompt = `You are a search loop critic.
Decide if another iteration is needed.
Return strictly valid JSON.`;

export function buildCriticPrompt(input: {
  userMessage: string;
  iteration: number;
  candidateCount: number;
  topScores: number[];
  currentConfidence: number;
  previousTopIds: string[];
  currentTopIds: string[];
}): string {
  return [
    `User message: ${input.userMessage}`,
    `Iteration: ${input.iteration}`,
    `Candidate count: ${input.candidateCount}`,
    `Top scores: ${input.topScores.map((value) => value.toFixed(3)).join(", ")}`,
    `Current confidence: ${input.currentConfidence.toFixed(3)}`,
    `Previous top ids: ${input.previousTopIds.join(", ") || "None"}`,
    `Current top ids: ${input.currentTopIds.join(", ") || "None"}`,
    "",
    "If confidence is already strong or results converged, stop.",
    "If quality likely improves with more queries, continue and optionally add up to 3 new query variants.",
  ].join("\n");
}
