import type { ChatMessage, ClarificationRequestData } from "@/types/chat";
import { runAgenticSearch, resumeAgentWithClarification } from "@/lib/agent/agentic-orchestrator";
import { SEARCH_UNAVAILABLE_MESSAGE } from "@/lib/search/user-facing-errors";

export const runtime = "nodejs";

type ChatRequestBody = {
  messages: ChatMessage[];
  clientContext?: {
    previousCandidateIds?: string[];
  };
  sessionId?: string;
};

type ClarificationResponseBody = {
  type: "clarification_response";
  sessionId: string;
  selection: string;
};

type RequestBody = ChatRequestBody | ClarificationResponseBody;

function isClarificationResponse(body: RequestBody): body is ClarificationResponseBody {
  return "type" in body && body.type === "clarification_response";
}

function encodeEvent(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as RequestBody;

  // Handle clarification response (resume agent)
  if (isClarificationResponse(body)) {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const result = await resumeAgentWithClarification(
            body.sessionId,
            body.selection,
            {
              messages: [],
              clientContext: { previousCandidateIds: [] },
              sessionId: body.sessionId,
              onActivity: async (event) => {
                controller.enqueue(encodeEvent({ type: "activity", data: event }));
              },
              onPartialText: async (text) => {
                controller.enqueue(encodeEvent({ type: "partial_text", data: { text } }));
              },
            }
          );

          controller.enqueue(
            encodeEvent({
              type: "final_answer",
              data: {
                content: result.content,
                references: result.references,
                companiesById: result.companiesById,
                telemetry: result.telemetry,
              },
            })
          );
        } catch (error) {
          console.error("[api/chat] Failed to resume search", error);
          controller.enqueue(encodeEvent({ type: "error", data: { message: SEARCH_UNAVAILABLE_MESSAGE } }));
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

  // Handle initial search request
  const sessionId = body.sessionId ?? crypto.randomUUID();
  const messages = body.messages ?? [];
  const previousCandidateIds = body.clientContext?.previousCandidateIds ?? [];

  // Track if we've sent a clarification request
  let clarificationData: ClarificationRequestData | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const result = await runAgenticSearch({
          messages,
          sessionId,
          clientContext: { previousCandidateIds },
          onActivity: async (event) => {
            controller.enqueue(encodeEvent({ type: "activity", data: event }));
          },
          onPartialText: async (text) => {
            controller.enqueue(encodeEvent({ type: "partial_text", data: { text } }));
          },
          onClarificationRequest: (data) => {
            clarificationData = data;
          },
        });

        // If result is null, it means we're waiting for clarification
        if (result === null && clarificationData) {
          controller.enqueue(
            encodeEvent({
              type: "clarification_request",
              data: clarificationData,
            })
          );
          // Don't close the stream yet - the client will resume with a new request
          controller.close();
          return;
        }

        if (result) {
          controller.enqueue(
            encodeEvent({
              type: "final_answer",
              data: {
                content: result.content,
                references: result.references,
                companiesById: result.companiesById,
                telemetry: result.telemetry,
              },
            })
          );
        }
      } catch (error) {
        console.error("[api/chat] Failed to run search", error);
        controller.enqueue(encodeEvent({ type: "error", data: { message: SEARCH_UNAVAILABLE_MESSAGE } }));
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
