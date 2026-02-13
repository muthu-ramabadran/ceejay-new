import type { ResumeStreamEvent } from "@/lib/resume/schemas";
import { extractTextFromPdf, extractResumeProfile } from "@/lib/resume/extract";
import { generateSearchPlan, executeSearchPlan, fetchAndGroupResults } from "@/lib/resume/search-strategy";

export const runtime = "nodejs";

const TEXT_EXTRACTION_TIMEOUT_MS = 90_000;
const PROFILE_EXTRACTION_TIMEOUT_MS = 180_000;
const SEARCH_PLAN_TIMEOUT_MS = 120_000;
const SEARCH_EXECUTION_TIMEOUT_MS = 480_000;
const GROUPING_TIMEOUT_MS = 300_000;
const STREAM_FLUSH_PAD = ".".repeat(2048);

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function encodeEvent(event: ResumeStreamEvent): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

export async function POST(request: Request): Promise<Response> {
  const runId = crypto.randomUUID().slice(0, 8);
  const startedAtMs = Date.now();
  const elapsedMs = () => Date.now() - startedAtMs;
  const contentType = request.headers.get("content-type") ?? "";

  if (!contentType.includes("multipart/form-data")) {
    return new Response(JSON.stringify({ error: "Expected multipart/form-data" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const formData = await request.formData();
  const file = formData.get("resume");

  if (!file || !(file instanceof File)) {
    return new Response(JSON.stringify({ error: "No resume file provided" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (file.size > 5 * 1024 * 1024) {
    return new Response(JSON.stringify({ error: "File exceeds 5MB limit" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (file.type !== "application/pdf") {
    return new Response(JSON.stringify({ error: "Only PDF files are supported" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.info(`[resume:${runId}] accepted file="${file.name}" size=${file.size}B`);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      const stopHeartbeat = () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      };
      const startHeartbeat = (stage: string) => {
        stopHeartbeat();
        heartbeatTimer = setInterval(() => {
          controller.enqueue(
            encodeEvent({
              type: "heartbeat",
              data: { stage, elapsedMs: elapsedMs(), pad: STREAM_FLUSH_PAD },
            })
          );
        }, 5_000);
      };

      setTimeout(() => {
        void (async () => {
          try {
          controller.enqueue(
            encodeEvent({
              type: "heartbeat",
              data: { stage: "init", elapsedMs: elapsedMs(), pad: STREAM_FLUSH_PAD },
            })
          );

          // Step 1: Extract text from PDF
          console.info(`[resume:${runId}] extract:start t=${elapsedMs()}ms`);
          controller.enqueue(
            encodeEvent({
              type: "activity",
              data: { id: "extract", label: "Extracting resume text", detail: file.name, status: "running" },
            })
          );

          const arrayBuffer = await file.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          const resumeText = await withTimeout(
            extractTextFromPdf(buffer),
            TEXT_EXTRACTION_TIMEOUT_MS,
            "PDF text extraction",
          );
          console.info(`[resume:${runId}] extract:done chars=${resumeText.length} t=${elapsedMs()}ms`);

          controller.enqueue(
            encodeEvent({
              type: "activity",
              data: { id: "extract", label: "Extracting resume text", detail: `${resumeText.length} characters`, status: "completed" },
            })
          );

          // Step 2: LLM extraction → ResumeProfile
          console.info(`[resume:${runId}] analyze:start t=${elapsedMs()}ms`);
          controller.enqueue(
            encodeEvent({
              type: "activity",
              data: { id: "analyze", label: "Analyzing your experience", detail: "Identifying domains and expertise", status: "running" },
            })
          );

          const profile = await withTimeout(
            extractResumeProfile(resumeText),
            PROFILE_EXTRACTION_TIMEOUT_MS,
            "Resume profile extraction",
          );
          console.info(`[resume:${runId}] analyze:done areas=${profile.experienceAreas.length} t=${elapsedMs()}ms`);

          controller.enqueue(
            encodeEvent({
              type: "activity",
              data: {
                id: "analyze",
                label: "Analyzing your experience",
                detail: `${profile.experienceAreas.length} experience areas, ${profile.totalYearsExperience} years`,
                status: "completed",
              },
            })
          );

          // Emit profile so UI can show it immediately
          controller.enqueue(encodeEvent({ type: "resume_profile", data: profile }));

          // Step 3: Generate search plan
          console.info(`[resume:${runId}] plan:start t=${elapsedMs()}ms`);
          controller.enqueue(
            encodeEvent({
              type: "activity",
              data: { id: "plan", label: "Planning searches", detail: "Generating targeted queries", status: "running" },
            })
          );

          const searchPlan = await withTimeout(
            generateSearchPlan(profile),
            SEARCH_PLAN_TIMEOUT_MS,
            "Search planning",
          );
          const totalQueries = searchPlan.coreSearches.length + searchPlan.adjacentSearches.length + (searchPlan.taxonomyFilters?.length ?? 0);
          console.info(`[resume:${runId}] plan:done queries=${totalQueries} t=${elapsedMs()}ms`);

          controller.enqueue(
            encodeEvent({
              type: "activity",
              data: {
                id: "plan",
                label: "Planning searches",
                detail: `${totalQueries} targeted queries`,
                status: "completed",
              },
            })
          );

          // Step 4: Execute all searches
          console.info(`[resume:${runId}] search:start total=${totalQueries} t=${elapsedMs()}ms`);
          startHeartbeat("search");
          controller.enqueue(
            encodeEvent({
              type: "activity",
              data: { id: "search", label: "Searching startups", detail: `Running ${totalQueries} searches`, status: "running" },
            })
          );

          const { results, adjacentIds } = await withTimeout(
            executeSearchPlan(searchPlan, (completed, total, currentQuery) => {
              controller.enqueue(
                encodeEvent({
                  type: "search_progress",
                  data: { completed, total, currentQuery },
                })
              );
            }),
            SEARCH_EXECUTION_TIMEOUT_MS,
            "Search execution",
          );
          stopHeartbeat();
          console.info(`[resume:${runId}] search:done unique=${results.size} adjacent=${adjacentIds.size} t=${elapsedMs()}ms`);

          controller.enqueue(
            encodeEvent({
              type: "activity",
              data: {
                id: "search",
                label: "Searching startups",
                detail: `Found ${results.size} unique companies`,
                status: "completed",
              },
            })
          );

          // Step 5: Fetch details and group results
          console.info(`[resume:${runId}] group:start companies=${results.size} t=${elapsedMs()}ms`);
          startHeartbeat("group");
          controller.enqueue(
            encodeEvent({
              type: "activity",
              data: { id: "group", label: "Organizing results", detail: `Grouping ${results.size} companies`, status: "running" },
            })
          );

          const { grouped, companiesById } = await withTimeout(
            fetchAndGroupResults(results, adjacentIds, profile),
            GROUPING_TIMEOUT_MS,
            "Result grouping",
          );
          stopHeartbeat();
          console.info(`[resume:${runId}] group:done groups=${grouped.groups.length} companies=${Object.keys(companiesById).length} t=${elapsedMs()}ms`);

          controller.enqueue(
            encodeEvent({
              type: "activity",
              data: {
                id: "group",
                label: "Organizing results",
                detail: `${grouped.groups.length} groups + Feeling Lucky`,
                status: "completed",
              },
            })
          );

          // Step 6: Emit final results
          controller.enqueue(
            encodeEvent({
              type: "final_results",
              data: { groups: grouped, companiesById },
            })
          );
          console.info(`[resume:${runId}] final:sent t=${elapsedMs()}ms`);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Resume processing failed";
            console.error(`[resume:${runId}] error t=${elapsedMs()}ms message="${message}"`);
            controller.enqueue(encodeEvent({ type: "error", data: { message } }));
          } finally {
            stopHeartbeat();
            controller.close();
            console.info(`[resume:${runId}] stream:closed t=${elapsedMs()}ms`);
          }
        })();
      }, 0);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "Content-Encoding": "identity",
      Connection: "keep-alive",
    },
  });
}
