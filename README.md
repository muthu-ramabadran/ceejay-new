# Ceejay UI Scaffold

UI-only scaffold for an agentic company-search chat interface.

## Phase Scope
- Chat UI with fixed mock assistant results
- Fake activity timeline (`Planning`, `Running searches`, `Filtering`, `Preparing results`)
- Clickable company references that open a details side panel
- Responsive: desktop split panel, mobile slide-over drawer

No real Supabase calls or retrieval logic are wired in this phase.

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
- `src/hooks/use-mock-agent-chat.ts`: fake staged activity and fixed replies
- `src/lib/mock/*`: typed fixed company dataset and assistant response
- `src/types/*`: strict TypeScript interfaces for company/chat models

## Next Phase
Swap mock search behavior behind `use-mock-agent-chat.ts` with real API/RPC calls while preserving the same UI boundaries.
