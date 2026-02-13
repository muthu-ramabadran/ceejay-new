import type { ResumeStreamEvent } from "@/lib/resume/schemas";
import { extractTextFromPdf, extractResumeProfile } from "@/lib/resume/extract";
import { generateSearchPlan, executeSearchPlan, fetchAndGroupResults } from "@/lib/resume/search-strategy";

export const runtime = "nodejs";

function encodeEvent(event: ResumeStreamEvent): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

export async function POST(request: Request): Promise<Response> {
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

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // Step 1: Extract text from PDF
        controller.enqueue(
          encodeEvent({
            type: "activity",
            data: { id: "extract", label: "Extracting resume text", detail: file.name, status: "running" },
          })
        );

        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const resumeText = await extractTextFromPdf(buffer);

        controller.enqueue(
          encodeEvent({
            type: "activity",
            data: { id: "extract", label: "Extracting resume text", detail: `${resumeText.length} characters`, status: "completed" },
          })
        );

        // Step 2: LLM extraction → ResumeProfile
        controller.enqueue(
          encodeEvent({
            type: "activity",
            data: { id: "analyze", label: "Analyzing your experience", detail: "Identifying domains and expertise", status: "running" },
          })
        );

        const profile = await extractResumeProfile(resumeText);

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
        controller.enqueue(
          encodeEvent({
            type: "activity",
            data: { id: "plan", label: "Planning searches", detail: "Generating targeted queries", status: "running" },
          })
        );

        const searchPlan = await generateSearchPlan(profile);
        const totalQueries = searchPlan.coreSearches.length + searchPlan.adjacentSearches.length + (searchPlan.taxonomyFilters?.length ?? 0);

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
        controller.enqueue(
          encodeEvent({
            type: "activity",
            data: { id: "search", label: "Searching startups", detail: `Running ${totalQueries} searches`, status: "running" },
          })
        );

        const { results, adjacentIds } = await executeSearchPlan(searchPlan, (completed, total, currentQuery) => {
          controller.enqueue(
            encodeEvent({
              type: "search_progress",
              data: { completed, total, currentQuery },
            })
          );
        });

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
        controller.enqueue(
          encodeEvent({
            type: "activity",
            data: { id: "group", label: "Organizing results", detail: `Grouping ${results.size} companies`, status: "running" },
          })
        );

        const { grouped, companiesById } = await fetchAndGroupResults(results, adjacentIds, profile);

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
      } catch (error) {
        const message = error instanceof Error ? error.message : "Resume processing failed";
        controller.enqueue(encodeEvent({ type: "error", data: { message } }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
