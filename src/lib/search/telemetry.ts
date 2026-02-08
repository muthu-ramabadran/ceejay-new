import type { SupabaseClient } from "@supabase/supabase-js";

interface SearchRunInsert {
  id: string;
  session_id: string;
  query_text: string;
  status_scope: string[];
  iteration_count: number;
  tool_call_count: number;
  final_candidate_count: number;
  end_reason: string;
  latency_ms: number;
}

interface SearchRunUpdate {
  session_id?: string;
  query_text?: string;
  status_scope?: string[];
  iteration_count?: number;
  tool_call_count?: number;
  final_candidate_count?: number;
  end_reason?: string;
  latency_ms?: number;
}

interface SearchRunStepInsert {
  run_id: string;
  iteration_no: number;
  step_order: number;
  tool_name: string;
  input_summary: Record<string, unknown>;
  output_summary: Record<string, unknown>;
  duration_ms: number;
  candidate_count_before: number;
  candidate_count_after: number;
}

interface SearchRunResultInsert {
  run_id: string;
  company_id: string;
  rank: number;
  confidence: number;
  evidence: Record<string, unknown>;
}

export async function insertSearchRun(client: SupabaseClient, payload: SearchRunInsert): Promise<string | null> {
  const { data, error } = await client
    .from("search_runs")
    .insert(payload)
    .select("id")
    .single<{ id: string }>();

  if (error) {
    console.error("insertSearchRun failed", error.message);
    return null;
  }

  return data.id;
}

export async function updateSearchRun(client: SupabaseClient, runId: string, payload: SearchRunUpdate): Promise<void> {
  const { error } = await client.from("search_runs").update(payload).eq("id", runId);
  if (error) {
    console.error("updateSearchRun failed", error.message);
  }
}

export async function insertSearchRunStep(client: SupabaseClient, payload: SearchRunStepInsert): Promise<void> {
  const { error } = await client.from("search_run_steps").insert(payload);
  if (error) {
    console.error("insertSearchRunStep failed", error.message);
  }
}

export async function insertSearchRunResults(client: SupabaseClient, payload: SearchRunResultInsert[]): Promise<void> {
  if (!payload.length) {
    return;
  }

  const { error } = await client.from("search_run_results").insert(payload);
  if (error) {
    console.error("insertSearchRunResults failed", error.message);
  }
}
