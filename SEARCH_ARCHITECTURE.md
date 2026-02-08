# Ceejay Search Architecture - End-to-End Documentation

This document provides a comprehensive analysis of how search works in the Ceejay application, from user input to final results.

## Table of Contents

1. [Overview](#1-overview)
2. [Tech Stack](#2-tech-stack)
3. [Architecture Diagram](#3-architecture-diagram)
4. [Frontend Layer](#4-frontend-layer)
5. [API Layer](#5-api-layer)
6. [Agent Orchestrator](#6-agent-orchestrator)
7. [LLM Prompts & Schemas](#7-llm-prompts--schemas)
8. [Database & Supabase Integration](#8-database--supabase-integration)
9. [Taxonomy System](#9-taxonomy-system)
10. [Type Definitions](#10-type-definitions)
11. [Key Algorithms](#11-key-algorithms)
12. [Example Flow](#12-example-flow)
13. [Configuration](#13-configuration)
14. [Performance Characteristics](#14-performance-characteristics)

---

## 1. Overview

Ceejay is a chat client for searching company data stored in Supabase. It uses an **agentic orchestration pattern** with multiple LLM-driven planning and refinement loops to deliver highly relevant company search results.

### Key Features

- Multi-round iterative search with convergence detection
- Combined vector + keyword + taxonomy search strategies
- LLM-powered planning, reranking, and critique
- Real-time streaming updates to the frontend
- Anchor company detection for "similar to X" queries
- Full telemetry and debugging support

---

## 2. Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 15.0.4, React 19.0.0, TypeScript 5.7.2 |
| Backend | Node.js runtime on Next.js API routes |
| Database | Supabase (PostgreSQL with RPC functions) |
| LLM Integration | OpenAI API via `@ai-sdk/openai` (v3.0.26) and `ai` (v6.0.77) |
| Vector Search | OpenAI embeddings (`text-embedding-3-small`) |
| UI | Radix UI, Tailwind CSS |
| Schema Validation | Zod v4.3.6 |
| Testing | Vitest |

---

## 3. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                           USER INTERFACE                             │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │  ChatShell Component                                             ││
│  │  ├── ChatComposer (text input)                                   ││
│  │  ├── MessageList (history + activity timeline)                   ││
│  │  └── CompanySidePanel (company details)                          ││
│  └─────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         useAgentChat Hook                            │
│  • Session management (UUID per browser session)                     │
│  • Previous candidate tracking for convergence                       │
│  • Stream processing (NDJSON format)                                 │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                          POST /api/chat
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         API Route Handler                            │
│  • Creates ReadableStream                                            │
│  • Streams NDJSON events back to client                              │
│  • Handles errors gracefully                                         │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    runAgenticSearch Orchestrator                     │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │  Phase 1: Anchor Detection                                       ││
│  │  • Extract company names from query                              ││
│  │  • Search for exact matches                                      ││
│  │  • Short-circuit if exact match (score >= 0.95)                  ││
│  └─────────────────────────────────────────────────────────────────┘│
│                                    │                                 │
│                                    ▼                                 │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │  Iterative Search Loop (max 10 iterations)                       ││
│  │  ┌─────────────────────────────────────────────────────────────┐││
│  │  │  Step 1: PLANNER (LLM)                                       │││
│  │  │  Generate query variants, filters, search strategy           │││
│  │  └─────────────────────────────────────────────────────────────┘││
│  │                                 │                                ││
│  │                                 ▼                                ││
│  │  ┌─────────────────────────────────────────────────────────────┐││
│  │  │  Step 2: EMBEDDING (LLM)                                     │││
│  │  │  Convert query variants to vectors                           │││
│  │  └─────────────────────────────────────────────────────────────┘││
│  │                                 │                                ││
│  │                                 ▼                                ││
│  │  ┌─────────────────────────────────────────────────────────────┐││
│  │  │  Step 3: MULTI-STRATEGY SEARCH (Supabase RPC)                │││
│  │  │  ├── Hybrid Search (vector + keyword)                        │││
│  │  │  ├── Keyword Search (BM25)                                   │││
│  │  │  └── Taxonomy Search (sectors/categories)                    │││
│  │  └─────────────────────────────────────────────────────────────┘││
│  │                                 │                                ││
│  │                                 ▼                                ││
│  │  ┌─────────────────────────────────────────────────────────────┐││
│  │  │  Step 4: RERANKER (LLM)                                      │││
│  │  │  Re-rank candidates by semantic relevance                    │││
│  │  └─────────────────────────────────────────────────────────────┘││
│  │                                 │                                ││
│  │                                 ▼                                ││
│  │  ┌─────────────────────────────────────────────────────────────┐││
│  │  │  Step 5: CRITIC (LLM)                                        │││
│  │  │  Decide: continue searching or stop?                         │││
│  │  └─────────────────────────────────────────────────────────────┘││
│  │                                 │                                ││
│  │                    ┌────────────┴────────────┐                   ││
│  │                    ▼                         ▼                   ││
│  │              [continue]                    [stop]                ││
│  │            Add new queries              Break loop               ││
│  │                    │                         │                   ││
│  │                    └─────────────────────────┘                   ││
│  └─────────────────────────────────────────────────────────────────┘│
│                                    │                                 │
│                                    ▼                                 │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │  Final Phase: Summary Generation                                 ││
│  │  • Generate 2-3 sentence summary via LLM                         ││
│  │  • Build references with evidence chips                          ││
│  │  • Return final payload with telemetry                           ││
│  └─────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Supabase Database                             │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │  RPC Functions                                                   ││
│  │  • search_exact_name_v1                                          ││
│  │  • search_companies_hybrid_v1                                    ││
│  │  • search_companies_keyword_v1                                   ││
│  │  • search_companies_by_taxonomy_v1                               ││
│  │  • get_companies_by_ids_v1                                       ││
│  └─────────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │  Telemetry Tables                                                ││
│  │  • search_runs                                                   ││
│  │  • search_run_steps                                              ││
│  │  • search_run_results                                            ││
│  └─────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

---

## 4. Frontend Layer

### Entry Point
**File**: `src/app/page.tsx`

The main page renders the `<ChatShell/>` component which manages the entire chat interface.

### Chat Shell Component
**File**: `src/components/chat/chat-shell.tsx`

```typescript
// Layout wrapper combining:
// - MessageList (history + activity timeline)
// - ChatComposer (text input)
// - CompanySidePanel (company details on click)

export function ChatShell() {
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const chat = useAgentChat();
  // ...
}
```

### Chat Composer
**File**: `src/components/chat/chat-composer.tsx`

- Text input with placeholder: *"Ask for startups by niche, for example: companies focused on AI healthcare"*
- Submits on Enter key or Send button click
- Calls `onSubmit(trimmed)` with user message

### useAgentChat Hook
**File**: `src/hooks/use-agent-chat.ts`

This is the core frontend hook that manages the chat state and communication with the API.

```typescript
export function useAgentChat() {
  // Session management
  const sessionIdRef = useRef(uuidv4());
  const previousCandidateIdsRef = useRef<string[]>([]);

  // State
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activitySteps, setActivitySteps] = useState<AgentActivityStep[]>([]);
  const [companiesById, setCompaniesById] = useState<Record<string, Company>>({});

  async function sendMessage(content: string) {
    // POST to /api/chat with:
    // - sessionId
    // - messages (full history)
    // - clientContext: { previousCandidateIds }

    // Process NDJSON stream with event types:
    // - activity: Show planning/search progress
    // - partial_text: Streaming text preview
    // - final_answer: Complete results
    // - error: Error handling
  }
}
```

### Stream Event Types

| Event Type | Description |
|------------|-------------|
| `activity` | Shows realtime progress (planning, searching, iterating) |
| `partial_text` | Streaming preview of AI-generated summary |
| `final_answer` | Complete results with references and company data |
| `error` | Error message to display |

---

## 5. API Layer

### Chat Route Handler
**File**: `src/app/api/chat/route.ts`

```typescript
export async function POST(request: NextRequest) {
  const { messages, sessionId, clientContext } = await request.json();

  // Create streaming response
  const stream = new ReadableStream({
    async start(controller) {
      // Helper to send NDJSON events
      const encodeEvent = (event: AgentStreamEvent) =>
        encoder.encode(JSON.stringify(event) + "\n");

      // Run the search orchestrator
      await runAgenticSearch({
        messages,
        sessionId,
        clientContext,
        onActivity: (event) => {
          controller.enqueue(encodeEvent({ type: "activity", data: event }));
        },
        onPartialText: (text) => {
          controller.enqueue(encodeEvent({ type: "partial_text", data: { text } }));
        },
      });

      // Send final answer
      controller.enqueue(encodeEvent({
        type: "final_answer",
        data: { content, references, companiesById, telemetry }
      }));
      controller.close();
    }
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" }
  });
}
```

---

## 6. Agent Orchestrator

**File**: `src/lib/agent/orchestrator.ts` (1,482 lines)

This is the heart of the search system. It implements a multi-round agentic search pattern.

### Configuration Constants

```typescript
const LOOP_LIMITS = {
  maxIterations: 10,          // Max refinement rounds
  maxToolCalls: 40,           // Max LLM/RPC calls
  maxRuntimeMs: 60_000,       // 60 second timeout
};

const EXACT_SHORT_CIRCUIT_THRESHOLD = 0.95;  // Exit on exact match
const ANCHOR_MATCH_THRESHOLD = 0.8;          // Similarity search anchor
```

### Phase 1: Anchor Detection

The system first looks for company names in the query to use as reference points.

```typescript
// Extract potential company names from query
function extractAnchorNameCandidates(text: string): string[] {
  // Looks for:
  // - Quoted strings: "Figma" or 'Notion'
  // - Patterns like: "like X", "similar to Y", "vs Z"
  // - Alphanumeric tokens
  // Returns max 8 normalized candidates
}

// Detect if user wants similar companies
function isSimilarityIntent(text: string): boolean {
  // Regex: like|similar|competitor|alternative|vs|versus
}
```

**Exact Name Search**:
```typescript
for (const candidate of anchorCandidates) {
  const results = await searchExactName(supabase, {
    queryText: candidate,
    statuses: ["startup"],
    limit: 5
  });
  // Track best match by nameScore
}
```

**Short-Circuit Logic**:
- If exact match score >= 0.95 → Return immediately with that company
- If exact match score >= 0.8 and similarity intent detected → Use as anchor for related search

### Phase 2: Iterative Planning & Search Loop

The system runs up to 10 iterations with the following steps per iteration:

#### Step 1: Planning (LLM)

```typescript
const plannerPrompt = buildPlannerPrompt({
  userMessage,
  chatSummary: asSummary(messages),          // Last 6 messages
  previousCandidateIds: state.priorTopIds,   // Top 5 from prev iteration
  taxonomyPrompt: getTaxonomyPrompt(),       // All sectors/categories
  searchableFieldsPrompt: getSearchableFieldsPrompt(),
  anchorCompanyContext: buildAnchorContext(anchorCompany)
});

const planner = await generateObject({
  model: openai(OPENAI_MODEL),
  schema: plannerSchema,
  system: plannerSystemPrompt,
  prompt: plannerPrompt
});
```

**Planner Output Schema**:
```typescript
{
  intent: "discover" | "narrow" | "compare" | "find_company",
  targetResultCount: 1-20,
  queryVariants: ["query1", "query2", ...],  // 1-6 variants
  searchPriorityOrder: ["exact_name", "hybrid", "keyword", "taxonomy"],
  filters: {
    statuses: ["startup", ...],
    sectors: ["Fintech", ...],
    categories: ["Payments", ...],
    businessModels: ["SaaS", ...],
    niches: ["AI", ...],
    nicheMode: "boost" | "must_match"
  },
  successCriteria: "Find highest relevance companies..."
}
```

#### Step 2: Embedding (LLM)

```typescript
const queries = dedupeStrings(plan.queryVariants).slice(0, 6);
const embeddings = await embedMany({
  model: openai.embedding(OPENAI_EMBEDDING_MODEL),  // text-embedding-3-small
  values: queries
});
// Returns: number[][] with ~1536-dim vectors
```

#### Step 3: Multi-Strategy Search (Supabase RPC)

**A. Hybrid Search** (Vector + Keyword):
```typescript
const hybridRows = await searchHybrid(supabase, {
  queryText,
  queryEmbedding,           // Vector embedding
  statuses: plan.filters.statuses,
  limit: 120,
  excludeIds: [anchorCompany?.id]
});
// Returns: [{ companyId, semanticScore, keywordScore, nicheScore, combinedScore, matchedFields, matchedTerms }]
```

**B. Keyword Search** (BM25):
```typescript
const keywordRows = await searchKeyword(supabase, {
  queryText,
  statuses: plan.filters.statuses,
  limit: 120
});
```

**C. Taxonomy Search**:
```typescript
const taxonomyRows = await searchByTaxonomy(supabase, {
  sectors: plan.filters.sectors,
  categories: plan.filters.categories,
  businessModels: plan.filters.businessModels,
  statuses: plan.filters.statuses,
  limit: 500
});
```

**Candidate Aggregation**:
- Merge results from all search strategies
- Take max scores for each company across searches
- Deduplicate and combine matched fields/terms

#### Step 4: Reranking (LLM)

```typescript
const reranked = await generateObject({
  model: openai(OPENAI_MODEL),
  schema: rerankerSchema,
  system: rerankerSystemPrompt,
  prompt: buildRerankerPrompt({
    userMessage,
    plan,
    candidates: ranked.slice(0, 30)
  })
});
```

**Reranker Output**:
```typescript
{
  confidence: 0-1,
  rankedCompanyIds: ["id1", "id2", ...],
  perCompany: [{
    companyId: string,
    reason: string,
    evidenceChips: string[],
    confidence: number
  }]
}
```

#### Step 5: Critic Decision (LLM)

```typescript
const critic = await generateObject({
  model: openai(OPENAI_MODEL),
  schema: criticSchema,
  system: criticSystemPrompt,
  prompt: buildCriticPrompt({
    userMessage,
    iteration,
    candidateCount,
    topScores,
    currentConfidence,
    previousTopIds: state.priorTopIds,
    currentTopIds: topIds
  })
});
```

**Critic Output**:
```typescript
{
  decision: "continue" | "stop",
  why: string,
  confidenceTargetMet: boolean,
  shouldExpandQueries: boolean,
  newQueryVariants: string[]
}
```

### Exit Conditions

The loop exits when any of these conditions are met:

| Condition | End Reason |
|-----------|------------|
| Exact match with score >= 0.95 | `exact_match` |
| Critic says "stop" AND confidence >= 0.74 | `confidence_met` |
| Top 5 company IDs unchanged from previous iteration | `converged` |
| Max iterations (10) reached | `guardrail_hit` |
| Max tool calls (40) reached | `guardrail_hit` |
| Max runtime (60s) exceeded | `guardrail_hit` |

### Phase 3: Summary Generation

```typescript
const summaryResult = await generateText({
  model: openai(OPENAI_MODEL),
  prompt: `Write a concise 2-3 sentence summary for this company search request: ${userMessage}. Mention overall fit and confidence without listing every result.`
});
```

### Final Return Payload

```typescript
{
  content: summaryResult.text,
  references: [{
    companyId: string,
    companyName: string,
    reason: string,
    inlineDescription: string,
    evidenceChips: string[],  // e.g., ["Similar to X", "Hybrid Match"]
    confidence: number
  }],
  companiesById: Record<string, Company>,
  telemetry: {
    runId: string,
    iterationCount: number,
    toolCallCount: number,
    endReason: "exact_match" | "confidence_met" | "converged" | "guardrail_hit" | "error"
  }
}
```

---

## 7. LLM Prompts & Schemas

**File**: `src/lib/agent/prompts.ts`

### Planner System Prompt

```
You are an agentic search planner for startup company discovery.
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
- Prefer query variants that target actual searchable fields (description, product_description, problem_solved, target_customer, differentiator, niches, sectors, categories, business_models).
```

### Reranker System Prompt

```
You are ranking company search candidates.
Return strictly valid JSON.
Prioritize precision and intent fit.
If exact name match exists, rank it first with high confidence.
```

### Critic System Prompt

```
You are a search loop critic.
Decide if another iteration is needed.
Return strictly valid JSON.
```

### Searchable Fields Prompt

```
Searchable fields in company dataset:
- company_name (exact and fuzzy)
- tagline
- description
- product_description
- target_customer
- problem_solved
- differentiator
- niches
- sectors
- categories
- business_models
```

### Zod Schemas
**File**: `src/lib/agent/schemas.ts`

```typescript
// Planner Schema
export const plannerSchema = z.object({
  intent: z.enum(["discover", "narrow", "compare", "find_company"]),
  targetResultCount: z.number().min(1).max(20),
  queryVariants: z.array(z.string()).min(1).max(6),
  searchPriorityOrder: z.array(
    z.enum(["exact_name", "hybrid", "keyword", "taxonomy"])
  ),
  filters: z.object({
    statuses: z.array(z.string()),
    sectors: z.array(z.string()),
    categories: z.array(z.string()),
    businessModels: z.array(z.string()),
    niches: z.array(z.string()),
    nicheMode: z.enum(["boost", "must_match"])
  }),
  successCriteria: z.string()
});

// Reranker Schema
export const rerankerSchema = z.object({
  confidence: z.number().min(0).max(1),
  rankedCompanyIds: z.array(z.string()),
  perCompany: z.array(z.object({
    companyId: z.string(),
    reason: z.string(),
    evidenceChips: z.array(z.string()),
    confidence: z.number()
  }))
});

// Critic Schema
export const criticSchema = z.object({
  decision: z.enum(["continue", "stop"]),
  why: z.string(),
  confidenceTargetMet: z.boolean(),
  shouldExpandQueries: z.boolean(),
  newQueryVariants: z.array(z.string())
});
```

---

## 8. Database & Supabase Integration

### Supabase Client Setup
**File**: `src/lib/supabase/server.ts`

```typescript
export function getSupabaseServerClient(): SupabaseClient {
  const env = getServerEnv();
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
```

### RPC Functions
**File**: `src/lib/search/rpc.ts`

#### 1. searchExactName

```typescript
await client.rpc("search_exact_name_v1", {
  p_query_text: queryText,
  p_statuses: ["startup"],
  p_limit: 5
});
// Returns: [{ company_id, name_score, matched_name }]
```

#### 2. searchHybrid

```typescript
await client.rpc("search_companies_hybrid_v1", {
  p_query_text: queryText,
  p_query_embedding: vectorLiteral(embedding),  // pgvector format
  p_statuses: ["startup"],
  p_limit: 120,
  p_min_semantic: 0.25,
  p_exclude_ids: excludeIds
});
// Returns: [{ company_id, semantic_score, keyword_score, niche_score, combined_score, matched_fields, matched_terms }]
```

#### 3. searchKeyword

```typescript
await client.rpc("search_companies_keyword_v1", {
  p_query_text: queryText,
  p_statuses: ["startup"],
  p_limit: 120
});
// Returns: [{ company_id, keyword_score, niche_score, combined_score, matched_terms }]
```

#### 4. searchByTaxonomy

```typescript
await client.rpc("search_companies_by_taxonomy_v1", {
  p_sectors: [...],
  p_categories: [...],
  p_business_models: [...],
  p_statuses: ["startup"],
  p_limit: 500
});
// Returns: [{ company_id, sector_hits, category_hits, model_hits, tag_score }]
```

#### 5. getCompaniesByIds

```typescript
await client.rpc("get_companies_by_ids_v1", {
  p_company_ids: [...]
});
// Returns: Full Company objects with all fields
```

### Telemetry Tables
**File**: `src/lib/search/telemetry.ts`

| Table | Purpose |
|-------|---------|
| `search_runs` | Track overall search execution (session, query, iterations, end reason) |
| `search_run_steps` | Log each RPC/LLM call within a run |
| `search_run_results` | Log final ranked results per run |

---

## 9. Taxonomy System

**File**: `src/lib/search/taxonomy.ts`

### Sectors (16 total)

- Fintech
- Healthcare
- Developer Tools
- Enterprise Software
- Consumer
- Commerce
- Data & Analytics
- Security
- Infrastructure
- Climate & Energy
- Industrials
- Media & Entertainment
- Education
- Real Estate
- Legal

### Categories (192 total)

Hierarchically organized under sectors. Examples:

| Sector | Categories |
|--------|------------|
| Fintech | Payments, Lending, Embedded Finance, Banking Infrastructure, etc. |
| Healthcare | Digital Health, Telehealth, Clinical Software, etc. |
| Developer Tools | Engineering Tools, DevOps & CI/CD, Code Collaboration, etc. |

### Business Models (18 total)

SaaS, Marketplace, Platform, API-First, Infrastructure, Consumer App, Hardware, Services, Open Source, Freemium, B2B, B2C, B2B2C, Enterprise, SMB, Usage-Based, Subscription, Transactional

---

## 10. Type Definitions

### Chat Types
**File**: `src/types/chat.ts`

```typescript
interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  references?: CompanyReference[];
  createdAt: string;
}

interface AgentActivityStep {
  id: string;
  label: string;
  detail: string;
  status: "pending" | "running" | "completed";
}

type AgentStreamEvent =
  | { type: "activity"; data: AgentActivityEventPayload }
  | { type: "partial_text"; data: { text: string } }
  | { type: "final_answer"; data: FinalAnswerPayload }
  | { type: "error"; data: { message: string } };
```

### Company Types
**File**: `src/types/company.ts`

```typescript
interface Company {
  id: string;
  website_url: string;
  status: "startup" | "acquired" | "closed" | "ipoed" | string;
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
  sectors: string[];
  categories: string[];
  niches: string[];
  business_models: string[];
  founders: Founder[];
  funding_rounds: FundingRound[];
  investors: string[];
  team_size: string | null;
  social_links: Record<string, string>;
  recent_news: string[];
}

interface CompanyReference {
  companyId: string;
  companyName: string;
  reason: string;
  inlineDescription?: string;
  evidenceChips?: string[];
  confidence?: number;
}
```

### Search Types
**File**: `src/lib/search/types.ts`

```typescript
interface SearchCandidate {
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

interface RankedCandidate extends SearchCandidate {
  rank: number;
  confidence: number;
  reason: string;
}

interface AgentPlan {
  intent: "discover" | "narrow" | "compare" | "find_company";
  targetResultCount: number;
  queryVariants: string[];
  searchPriorityOrder: ("exact_name" | "hybrid" | "keyword" | "taxonomy")[];
  filters: AgentFilterPlan;
  successCriteria: string;
}
```

---

## 11. Key Algorithms

### Candidate Scoring & Aggregation

```typescript
// Merge results from multiple searches, taking max scores
function buildCandidateMap(
  existing: Map<string, SearchCandidate>,
  newRows: SearchRow[]
): Map<string, SearchCandidate> {
  for (const row of newRows) {
    const existing = map.get(row.companyId);
    if (existing) {
      // Take max of each score type
      existing.semanticScore = Math.max(existing.semanticScore, row.semanticScore);
      existing.keywordScore = Math.max(existing.keywordScore, row.keywordScore);
      // ... combine matched fields and terms
    } else {
      map.set(row.companyId, newCandidate(row));
    }
  }
  return map;
}
```

### Convergence Detection

```typescript
function converged(previousTopIds: string[], currentTopIds: string[]): boolean {
  // Check if top 5 company IDs are unchanged
  if (previousTopIds.length !== currentTopIds.length) return false;
  return previousTopIds.every((id, i) => id === currentTopIds[i]);
}
```

### Anchor Company Context Building

```typescript
function buildAnchorContext(anchor: Company | undefined): string {
  if (!anchor) return "";
  return `
company_name: ${anchor.company_name}
tagline: ${anchor.tagline || ""}
description: ${anchor.description || ""}
product_description: ${anchor.product_description || ""}
niches: ${anchor.niches.join(", ")}
sectors: ${anchor.sectors.join(", ")}
categories: ${anchor.categories.join(", ")}
`.trim();
}
```

---

## 12. Example Flow

**User Query**: *"Show me healthcare AI companies similar to Athenahealth"*

### Step 1: Frontend Sends Request
```json
POST /api/chat
{
  "messages": [{ "role": "user", "content": "Show me healthcare AI companies similar to Athenahealth" }],
  "sessionId": "uuid-...",
  "clientContext": { "previousCandidateIds": [] }
}
```

### Step 2: Anchor Detection
```
extractAnchorNameCandidates() → ["Athenahealth"]
searchExactName("Athenahealth") → [{ company_id: "xyz", name_score: 0.98 }]
getCompaniesByIds(["xyz"]) → Full Athenahealth company object
anchorCompany = Athenahealth (sectors: Healthcare, niches: Clinical Software, AI)
```

### Step 3: Iteration 1 - Planning
```json
{
  "intent": "discover",
  "targetResultCount": 12,
  "queryVariants": ["healthcare AI clinical software", "AI-powered EHR", "clinical decision support"],
  "searchPriorityOrder": ["hybrid", "keyword", "taxonomy"],
  "filters": {
    "statuses": ["startup"],
    "sectors": ["Healthcare"],
    "categories": ["Clinical Software"],
    "businessModels": ["SaaS"],
    "niches": ["AI", "Clinical"],
    "nicheMode": "boost"
  }
}
```

### Step 4: Embedding & Search
```
embedMany(["healthcare AI clinical software", ...]) → [vector1, vector2, vector3]

searchHybrid(vector1, ...) → 45 results
searchHybrid(vector2, ...) → 38 results
searchKeyword("healthcare AI...") → 52 results
searchByTaxonomy(sectors: Healthcare, ...) → 120 results

Aggregated candidates: 85 unique companies
```

### Step 5: Reranking
```json
{
  "confidence": 0.82,
  "rankedCompanyIds": ["abc", "def", "ghi", ...],
  "perCompany": [
    { "companyId": "abc", "reason": "AI-powered clinical workflow platform", "confidence": 0.88 }
  ]
}
```

### Step 6: Critic Decision
```json
{
  "decision": "continue",
  "why": "Results promising but could improve with refinement",
  "shouldExpandQueries": true,
  "newQueryVariants": ["telehealth clinical AI", "healthcare workflow automation"]
}
```

### Step 7: Iteration 2-3
```
Add new query variants → Re-run planning → Search → Rerank → Critique
```

### Step 8: Convergence
```
After Iteration 3:
- Critic says "stop" (confidence 0.78 >= 0.74)
- endReason = "confidence_met"
```

### Step 9: Summary Generation
```
"Found 8 healthcare AI companies with strong similarity to Athenahealth, focusing on clinical workflow automation and EHR integration. Overall confidence: 0.82."
```

### Step 10: Final Response
```json
{
  "type": "final_answer",
  "data": {
    "content": "Found 8 healthcare AI companies...",
    "references": [
      {
        "companyId": "abc",
        "companyName": "Company A",
        "reason": "AI-powered clinical workflow...",
        "confidence": 0.88,
        "evidenceChips": ["Similar to Athenahealth", "Hybrid Match", "Clinical Software"]
      }
    ],
    "companiesById": { "abc": {...} },
    "telemetry": {
      "iterationCount": 3,
      "toolCallCount": 18,
      "endReason": "confidence_met"
    }
  }
}
```

---

## 13. Configuration

### Environment Variables

```bash
# OpenAI API
OPENAI_API_KEY=your-key-here
OPENAI_MODEL=gpt-4o-mini                        # Default LLM model
OPENAI_EMBEDDING_MODEL=text-embedding-3-small   # Embedding model

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

### Configurable Limits

| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxIterations` | 10 | Maximum refinement rounds |
| `maxToolCalls` | 40 | Maximum LLM/RPC calls per search |
| `maxRuntimeMs` | 60,000 | Maximum runtime in milliseconds |
| `EXACT_SHORT_CIRCUIT_THRESHOLD` | 0.95 | Exit on exact name match |
| `ANCHOR_MATCH_THRESHOLD` | 0.8 | Use as anchor for similarity search |

---

## 14. Performance Characteristics

| Metric | Value |
|--------|-------|
| Max iterations | 10 |
| Max tool calls | 40 per search |
| Max runtime | 60 seconds |
| Candidates per iteration | 30 reranked, 80 tracked |
| Query variants | 1-6 per iteration, up to 8 total |
| Search limits | Exact: 5, Hybrid: 120, Keyword: 120, Taxonomy: 500 |
| Vector dimension | ~1536 (text-embedding-3-small) |
| LLM model | gpt-4o-mini (default) |
| Embedding model | text-embedding-3-small |

---

## Summary

The Ceejay search system is a sophisticated **multi-round agentic search platform** that combines:

1. **Vector + Keyword + Taxonomy search** via Supabase RPC functions
2. **LLM-driven planning** to generate diverse query strategies
3. **Structured output** using Zod schemas for deterministic results
4. **Iterative refinement** with convergence detection and confidence thresholds
5. **Real-time streaming** to frontend with activity timeline
6. **Full telemetry** for debugging and analysis

The key innovation is the **critic loop** that decides when to stop searching, balancing between exhaustive search and premature stopping to deliver high-quality, relevant results.
