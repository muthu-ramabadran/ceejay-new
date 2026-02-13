import type { AgentPlan, RankedCandidate } from "@/lib/search/types";

export type AgentRequestMode = "new" | "more" | "filter" | "similar";

export interface AgentRuntimePromptInput {
  userMessage: string;
  requestMode: AgentRequestMode;
  targetResultCount: number;
  previousCandidateIds: string[];
  shouldClarifyBeforeSearch: boolean;
}

export const agentSystemPrompt = `You are a tool-calling company search agent for startup discovery.

Rules:
1. You must respond with tool calls only. Never write a natural-language final answer directly.
2. For new/similar discovery, run at least 2 distinct search queries with query variation before finalizing, unless this is an exact-name lookup.
3. You must call get_company_details before calling finalize_search.
4. For ambiguous queries:
- Clarify immediately if the user query is clearly underspecified.
- Otherwise run a quick probe (search + details). If top candidates split across multiple plausible intents, call clarify_with_user.
5. finalize_search should contain only companies that satisfy the active request constraints and should match the requested result count as closely as possible.
6. Prefer high precision over broad recall. Use niches/product/problem/target_customer evidence, not keyword overlap alone.
7. If no strong matches exist, return a short ranked list with low confidence rather than inventing relevance.

Searchable fields:
- company_name, tagline, description, product_description, target_customer, problem_solved, differentiator, niches, sectors, categories, business_models

Tooling expectations:
- search_semantic: primary discovery by meaning
- search_keyword: exact terminology disambiguation
- search_taxonomy: strict sector/category/model filters
- get_company_details: mandatory validation before finalize_search
- clarify_with_user: use only when intent cannot be resolved confidently
- finalize_search: structured handoff of ranked results`;

export function buildAgentRuntimePrompt(input: AgentRuntimePromptInput): string {
  const previousPreview = input.previousCandidateIds.slice(0, 60);
  const previousIdsText = previousPreview.length ? previousPreview.join(", ") : "None";

  const modeRules: Record<AgentRequestMode, string[]> = {
    new: [
      "Treat as a fresh search request.",
      "Use semantic search first, then add at least one distinct adjacent/reframed query before finalize_search.",
      "Do not rely on only one literal restatement of the user message.",
    ],
    more: [
      "User asked for more/new results.",
      "Do not return any previously shown company IDs.",
      "Pass previous IDs via excludeCompanyIds when searching.",
    ],
    filter: [
      "User asked to refine/filter existing results.",
      "Prioritize filtering from previously shown company IDs.",
      "Do not broaden to unrelated new companies unless no filtered matches exist.",
    ],
    similar: [
      "User likely wants similar/alternative companies.",
      "If anchor company is present, find comparable offerings and exclude the anchor from final results.",
      "Use at least two distinct retrieval queries that capture different aspects of similarity.",
    ],
  };

  const clarificationRule = input.shouldClarifyBeforeSearch
    ? "This query is likely underspecified. Ask clarify_with_user before broad retrieval."
    : "Clarify only if evidence from top results indicates multiple competing intents.";

  return [
    "Runtime request constraints:",
    `- User message: ${input.userMessage}`,
    `- Request mode: ${input.requestMode}`,
    `- Target result count: ${input.targetResultCount}`,
    `- Previous candidate IDs count: ${input.previousCandidateIds.length}`,
    `- Previous candidate IDs: ${previousIdsText}`,
    ...modeRules[input.requestMode].map((rule) => `- ${rule}`),
    `- ${clarificationRule}`,
    "- Finalize with high-precision matches only and keep evidence concise.",
  ].join("\n");
}

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
