import type { ActionFunctionArgs } from "react-router";
import { requireRole, createAuditLog } from "../utils/auth.server";
import { streamChatAnswer, type ChatEvent, type ChatTurn } from "../utils/ai-chat.server";

// POST /api/ai-chat  { question, history: [{role, content}] }
//
// Streams newline-delimited JSON events back to the chat page: tool calls as
// they happen, then the answer token by token. Streaming (rather than one long
// POST) keeps the connection alive through a multi-lookup question instead of
// sitting silent past the proxy's timeout.
export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN", "MANAGER"]);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const question = String(body?.question ?? "").trim();
  if (!question) return Response.json({ error: "question is required" }, { status: 400 });

  const history: ChatTurn[] = Array.isArray(body?.history)
    ? body.history
        .filter((t: any) => (t?.role === "user" || t?.role === "assistant") && typeof t?.content === "string" && t.content.trim())
        .map((t: any) => ({ role: t.role, content: String(t.content).slice(0, 20000) }))
    : [];

  // Questions are logged (not answers) so there's a record of what the chat was
  // asked, the same way every other privileged screen is audited.
  createAuditLog(user.id, "AI_CHAT_QUERY", "AiChat", user.id, {
    question: question.slice(0, 500),
  }).catch((err) => console.error("[ai-chat] audit log failed:", err));

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (event: ChatEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          closed = true; // client hung up
        }
      };
      try {
        await streamChatAnswer(question, history, emit);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[ai-chat] failed:", message);
        emit({ type: "error", message });
      } finally {
        closed = true;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
};
