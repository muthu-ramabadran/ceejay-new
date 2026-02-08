# Ceejay UI Scaffold

Agentic company-search chat interface.

## Current Scope
- Chat UI with inline references and details sidebar
- Real server-side agent orchestration in `POST /api/chat`
- Supabase-only retrieval via RPC (`exact_name`, `hybrid`, `keyword`, `taxonomy`)
- Iterative planning/reranking/critic loop using AI SDK
- Telemetry tables for run/step/result tracing

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Project Structure
- `src/components/chat/*`: chat shell, message list, composer, timeline
- `src/components/company/*`: reference chips and side panel details
- `src/components/ui/*`: shadcn-style primitives and state components
- `src/hooks/use-agent-chat.ts`: streaming client hook for `/api/chat`
- `src/lib/agent/*`: planner/reranker/critic prompts + orchestration loop
- `src/lib/search/*`: Supabase RPC wrappers, taxonomy, telemetry helpers
- `src/app/api/chat/route.ts`: agent search API endpoint
- `src/lib/mock/*`: local sample dataset used for initial UI bootstrapping/tests
- `src/types/*`: strict TypeScript interfaces for company/chat models

## Setup
1. Create your env file from `.env.example`.
2. Apply SQL migrations in order:
   - `supabase/migrations/0001_agentic_search.sql`
   - `supabase/migrations/0002_rpc_type_fixes.sql`
3. Ensure `company_embeddings` has `embedding_type='searchable_profile'` populated for your dataset.

## Search Observability
Each chat request writes a telemetry run and step-by-step trace.

- `search_runs`: one row per user reaction/query
- `search_run_steps`: ordered LLM + Supabase RPC calls with request/response summaries
- `search_run_results`: final ranked output per run

Use the `runId` returned in API telemetry to inspect internals.

```sql
-- Latest runs
select id, created_at, query_text, iteration_count, tool_call_count, end_reason, latency_ms
from search_runs
order by created_at desc
limit 20;
```

```sql
-- Full trace for one run (replace :run_id)
select iteration_no, step_order, tool_name, input_summary, output_summary, duration_ms
from search_run_steps
where run_id = :run_id
order by iteration_no asc, step_order asc, created_at asc;
```

```sql
-- Final ranked companies for one run
select rank, company_id, confidence, evidence
from search_run_results
where run_id = :run_id
order by rank asc;
```
