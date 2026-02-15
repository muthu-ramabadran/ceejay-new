# Ceejay

Next.js app for searching startup/company data stored in Supabase.

## Current Scope

- Main chat experience at `/` with streamed agent responses.
- Resume matching flow at `/resume`:
  - accepts PDF upload (max 5MB),
  - extracts profile with LLM,
  - runs multi-query search plan,
  - returns grouped company matches.
- Server endpoints stream NDJSON events:
  - `POST /api/chat`
  - `POST /api/resume`
- Search uses Supabase RPC functions:
  - `search_exact_name_v1`
  - `search_companies_hybrid_v1`
  - `search_companies_keyword_v1`
  - `search_companies_by_taxonomy_v1`
  - `get_companies_by_ids_v1`
- Chat search telemetry is persisted in:
  - `search_runs`
  - `search_run_steps`
  - `search_run_results`

## Requirements

- Node.js 20+
- npm
- Supabase project with:
  - base schema from `../company_data_scrapper/supabase/schema.sql`
  - migrations in this repo applied in order

## Environment

Create `ceejay/.env.local` from `ceejay/.env.example`:

```bash
cp .env.example .env.local
```

Required variables:

- `OPENAI_API_KEY`
- `OPENAI_MODEL` (default: `gpt-4o-mini`)
- `OPENAI_EMBEDDING_MODEL` (default: `text-embedding-3-small`)
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

## Database Setup

Apply these SQL files in order:

1. `../company_data_scrapper/supabase/schema.sql`
2. `supabase/migrations/0001_agentic_search.sql`
3. `supabase/migrations/0002_rpc_type_fixes.sql`
4. `supabase/migrations/0003_total_raised_normalization.sql`
5. `supabase/migrations/0004_search_matched_terms.sql`

The search flows assume `company_embeddings` includes `embedding_type='searchable_profile'`.

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Scripts

```bash
npm run dev
npm run build
npm run start
npm run lint
npm run typecheck
npm run test
```

## Project Structure

- `src/app/page.tsx`: chat page.
- `src/app/resume/page.tsx`: resume matching page.
- `src/app/api/chat/route.ts`: chat orchestration endpoint.
- `src/app/api/resume/route.ts`: resume extraction + search endpoint.
- `src/hooks/use-agent-chat.ts`: streaming chat state, including clarification handling.
- `src/hooks/use-resume-match.ts`: resume upload + streaming result state.
- `src/lib/agent/*`: agent orchestration, tools, prompts.
- `src/lib/resume/*`: resume extraction, planning, grouping logic.
- `src/lib/search/*`: RPC wrappers, type normalization, telemetry writes.
- `src/components/chat/*`: chat UI and activity timeline.
- `src/components/resume/*`: resume upload and grouped result UI.

## Operational Notes

- Clarification state in chat is currently stored in-memory on the server process.
- Restarting the server clears pending clarifications.

## Search Observability

Use these queries to inspect chat runs:

```sql
select id, created_at, query_text, iteration_count, tool_call_count, end_reason, latency_ms
from search_runs
order by created_at desc
limit 20;
```

```sql
select iteration_no, step_order, tool_name, input_summary, output_summary, duration_ms
from search_run_steps
where run_id = :run_id
order by iteration_no asc, step_order asc, created_at asc;
```

```sql
select rank, company_id, confidence, evidence
from search_run_results
where run_id = :run_id
order by rank asc;
```
