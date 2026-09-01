import type { ActionFunctionArgs } from "react-router";
import { requireRole } from "../utils/auth.server";
import { streamChatAnswer, type ChatEvent } from "../utils/ai-chat.server";
import {
  appendMessage,
  createConversation,
  recentTurns,
  type StoredTool,
} from "../utils/ai-log.server";
import prisma from "../db.server";

// POST /api/ai-chat  { question, conversationId? }
//
// Streams newline-delimited JSON events back to the chat page: tool calls as
// they happen, then the answer token by token. Streaming (rather than one long
// POST) keeps the connection alive through a multi-lookup question instead of
// sitting silent past the proxy's timeout.
//
// The transcript is written as it goes, so a conversation survives a refresh
// and can be re-read later from the history list.
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

  // Continue an existing conversation only if it's one this user may write to.
  let conversationId: string | null = null;
  let title = "";
  if (body?.conversationId) {
    const existing = await prisma.aiConversation.findUnique({
      where: { id: String(body.conversationId) },
      select: { id: true, userId: true, title: true },
    });
    if (existing && (existing.userId === user.id || user.role === "ADMIN")) {
      conversationId = existing.id;
      title = existing.title;
    }
  }
  if (!conversationId) {
    const created = await createConversation(user.id, question);
    conversationId = created.id;
    title = created.title;
  }

  const history = await recentTurns(conversationId);
  await appendMessage(conversationId, { role: "user", content: question });

  const encoder = new TextEncoder();
  const convoId = conversationId;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      // Rebuild the answer from the events as they stream, so the saved
      // transcript is exactly what the user saw — including a partial answer
      // if they hit Stop.
      let answer = "";
      const tools: StoredTool[] = [];
      let failure: string | undefined;

      const emit = (event: ChatEvent) => {
        if (event.type === "delta") answer += event.text;
        else if (event.type === "tool") tools.push({ name: event.name, summary: event.summary });
        else if (event.type === "tool_done") {
          const pending = tools.find((t) => t.name === event.name && t.ms === undefined);
          if (pending) {
            pending.ms = event.ms;
            pending.ok = event.ok;
          }
        } else if (event.type === "error") failure = event.message;

        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          closed = true; // client hung up
        }
      };

      emit({ type: "conversation", id: convoId, title });

      try {
        await streamChatAnswer(question, history, emit);
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
        console.error("[ai-chat] failed:", failure);
        emit({ type: "error", message: failure });
      } finally {
        if (answer.trim() || tools.length > 0 || failure) {
          await appendMessage(convoId, {
            role: "assistant",
            content: answer,
            tools,
            error: failure,
          }).catch((err) => console.error("[ai-chat] could not save answer:", err));
        }
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed by the client disconnecting */
        }
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
