import type { ChatMessage } from "@/types/chat";
import { runAgenticSearch } from "@/lib/agent/orchestrator";

export const runtime = "nodejs";

type ChatRequestBody = {
  messages: ChatMessage[];
  clientContext?: {
    previousCandidateIds?: string[];
  };
  sessionId?: string;
};

function encodeEvent(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as ChatRequestBody;
  const sessionId = body.sessionId ?? crypto.randomUUID();
  const messages = body.messages ?? [];
  const previousCandidateIds = body.clientContext?.previousCandidateIds ?? [];

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
        });

        controller.enqueue(
          encodeEvent({
            type: "final_answer",
            data: {
              content: result.content,
              references: result.references,
              companiesById: result.companiesById,
              telemetry: result.telemetry,
            },
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Search failed";
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
