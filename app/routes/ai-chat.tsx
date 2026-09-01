import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { useEffect, useRef, useState } from "react";
import { requireRole } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import { Markdown } from "../components/Markdown";
import { isAiConfigured } from "../utils/ai-chat.server";
import {
  deleteConversation,
  getConversation,
  listConversations,
  type StoredTool,
} from "../utils/ai-log.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN", "MANAGER"]);
  const url = new URL(request.url);
  const activeId = url.searchParams.get("c");
  const showAll = url.searchParams.get("all") === "1" && user.role === "ADMIN";

  const [conversations, conversation] = await Promise.all([
    listConversations({ userId: user.id, role: user.role, all: showAll }),
    activeId ? getConversation(activeId, { userId: user.id, role: user.role }) : Promise.resolve(null),
  ]);

  return { user, configured: isAiConfigured(), conversations, conversation, showAll };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN", "MANAGER"]);
  const form = await request.formData();
  if (form.get("intent") === "delete") {
    const id = String(form.get("id") ?? "");
    await deleteConversation(id, { userId: user.id, role: user.role });
  }
  return redirect("/ai-chat");
};

type Message = {
  role: "user" | "assistant";
  content: string;
  tools?: StoredTool[];
  error?: string;
};

const SUGGESTIONS = [
  "What's short right now if we had to fill every unfulfilled order today?",
  "How many 100 grain 3-packs can we build with what's on the floor?",
  "If we needed to build 5,000 broadheads next month, what would we run out of first?",
  "What's the oldest unfulfilled order and what's holding it up?",
  "Which raw materials are on order and when do they land?",
  "How many units did we produce per process last week?",
];

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function AiChat() {
  const { user, configured, conversations, conversation, showAll } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const revalidator = useRevalidator();

  const [messages, setMessages] = useState<Message[]>(conversation?.messages ?? []);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState<Message | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const conversationIdRef = useRef<string | null>(conversation?.id ?? null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Follow the conversation named in the URL. Never while a request is in
  // flight — a revalidation mid-answer would yank the transcript out from
  // under what's currently streaming.
  const loadedId = conversation?.id ?? null;
  useEffect(() => {
    if (busy) return;
    conversationIdRef.current = loadedId;
    setMessages(conversation?.messages ?? []);
  }, [loadedId, busy, conversation]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, streaming, status]);

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;

    setMessages((prev) => [...prev, { role: "user", content: q }]);
    setInput("");
    setBusy(true);
    setStatus("Thinking");
    const live: Message = { role: "assistant", content: "", tools: [] };
    setStreaming({ ...live });

    const controller = new AbortController();
    abortRef.current = controller;
    let startedNewConversation = false;

    try {
      const res = await fetch("/api/ai-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, conversationId: conversationIdRef.current }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(
          res.status === 403
            ? "Your account doesn't have access to the AI chat."
            : `Server returned ${res.status}`
        );
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let event: any;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.type === "conversation") {
            if (conversationIdRef.current !== event.id) startedNewConversation = true;
            conversationIdRef.current = event.id;
          } else if (event.type === "delta") {
            live.content += event.text;
            setStatus(null);
          } else if (event.type === "tool") {
            live.tools = [...(live.tools ?? []), { name: event.name, summary: event.summary }];
            setStatus(event.summary);
          } else if (event.type === "tool_done") {
            const tools = [...(live.tools ?? [])];
            const idx = tools.findIndex((t) => t.name === event.name && t.ms === undefined);
            if (idx >= 0) tools[idx] = { ...tools[idx], ms: event.ms, ok: event.ok };
            live.tools = tools;
          } else if (event.type === "status") {
            setStatus(event.status === "thinking" ? "Thinking" : "Working through the numbers");
          } else if (event.type === "error") {
            live.error = event.message;
          }
          setStreaming({ ...live, tools: [...(live.tools ?? [])] });
        }
      }

      setMessages((prev) => [...prev, { ...live, tools: [...(live.tools ?? [])] }]);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        if (live.content.trim() || live.tools?.length) {
          setMessages((prev) => [...prev, { ...live, error: "Stopped." }]);
        }
      } else {
        setMessages((prev) => [
          ...prev,
          { ...live, error: err instanceof Error ? err.message : String(err) },
        ]);
      }
    } finally {
      setStreaming(null);
      setStatus(null);
      setBusy(false);
      abortRef.current = null;
      inputRef.current?.focus();

      // Put the conversation in the URL so a refresh (or a shared link) lands
      // back here, and refresh the history list's ordering.
      const id = conversationIdRef.current;
      if (startedNewConversation && id) {
        const next = new URLSearchParams(searchParams);
        next.set("c", id);
        setSearchParams(next, { replace: true, preventScrollReset: true });
      } else {
        revalidator.revalidate();
      }
    }
  };

  const stop = () => abortRef.current?.abort();

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ask(input);
    }
  };

  const readOnly = !!conversation && !conversation.mine;

  return (
    <Layout user={user}>
      <div className="page-header flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">AI Chat</h1>
          <p className="page-subtitle">
            Ask about inventory, orders, production, and what-ifs. It reads live data and can't change anything.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowHistory((v) => !v)}
            className="btn btn-ghost btn-sm md:hidden"
          >
            {showHistory ? "Hide history" : "History"}
          </button>
          <a href="/ai-chat" className="btn btn-secondary btn-sm">
            New chat
          </a>
        </div>
      </div>

      {!configured && (
        <div className="alert alert-warning mb-4">
          <strong>Not configured.</strong> Set <code>ANTHROPIC_API_KEY</code> in this
          environment (Render dashboard in production, <code>.env</code> locally) and restart.
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-[260px_1fr]">
        {/* History */}
        <div className={`${showHistory ? "block" : "hidden"} md:block`}>
          <div className="card">
            <div className="card-header !py-3">
              <span className="text-sm font-semibold text-gray-900">History</span>
              {user.role === "ADMIN" && (
                <a
                  href={showAll ? "/ai-chat" : "/ai-chat?all=1"}
                  className="text-xs text-gray-500 hover:text-gray-800"
                >
                  {showAll ? "Just mine" : "Everyone"}
                </a>
              )}
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              {conversations.length === 0 ? (
                <p className="text-sm text-gray-500 px-4 py-6">No conversations yet.</p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {conversations.map((c) => {
                    const active = c.id === conversation?.id;
                    return (
                      <li
                        key={c.id}
                        className={`group px-4 py-3 hover:bg-gray-50 ${active ? "bg-beast-50" : ""}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <a href={`/ai-chat?c=${c.id}`} className="min-w-0 flex-1">
                            <p
                              className={`text-sm truncate ${
                                active ? "text-beast-800 font-medium" : "text-gray-800"
                              }`}
                            >
                              {c.title}
                            </p>
                            <p className="text-xs text-gray-400 mt-0.5">
                              {relativeTime(c.updatedAt)}
                              {!c.mine && ` · ${c.author}`}
                            </p>
                          </a>
                          <Form method="post" onSubmit={(e) => {
                            if (!confirm("Delete this conversation?")) e.preventDefault();
                          }}>
                            <input type="hidden" name="intent" value="delete" />
                            <input type="hidden" name="id" value={c.id} />
                            <button
                              type="submit"
                              title="Delete"
                              className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600 transition-opacity"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                              </svg>
                            </button>
                          </Form>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>

        {/* Conversation */}
        <div className="card">
          <div className="card-body min-h-[55vh] max-h-[70vh] overflow-y-auto">
            {messages.length === 0 && !streaming && (
              <div className="py-6">
                <p className="text-sm font-medium text-gray-900 mb-1">Try one of these</p>
                <p className="text-sm text-gray-500 mb-4">
                  Or ask anything about SKUs, POs, transfers, unfulfilled orders, or build capacity.
                </p>
                <div className="grid gap-2 lg:grid-cols-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => ask(s)}
                      disabled={!configured}
                      className="text-left text-sm p-3 rounded-lg border border-gray-200 hover:border-beast-500 hover:bg-beast-50 transition-colors disabled:opacity-50"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {readOnly && (
              <p className="text-xs text-gray-500 mb-4">
                {conversation?.author}'s conversation, read only. Start a new chat to ask your own.
              </p>
            )}

            <div className="space-y-5">
              {messages.map((m, i) => (
                <ChatBubble key={i} message={m} />
              ))}
              {streaming && <ChatBubble message={streaming} status={status} live />}
            </div>
            <div ref={bottomRef} />
          </div>

          <div className="border-t border-gray-100 p-4">
            <div className="flex gap-2 items-end">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                rows={2}
                disabled={!configured || readOnly}
                placeholder={
                  readOnly ? "Start a new chat to ask a question" : "Ask about inventory, orders, or a what-if…"
                }
                className="form-textarea flex-1 resize-none"
              />
              {busy ? (
                <button onClick={stop} className="btn btn-secondary">
                  Stop
                </button>
              ) : (
                <button
                  onClick={() => ask(input)}
                  disabled={!input.trim() || !configured || readOnly}
                  className="btn btn-primary"
                >
                  Ask
                </button>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-2">
              Enter to send, Shift+Enter for a new line. Answers come from live system data — spot-check
              anything you're about to act on.
            </p>
          </div>
        </div>
      </div>
    </Layout>
  );
}

function ChatBubble({
  message,
  status,
  live,
}: {
  message: Message;
  status?: string | null;
  live?: boolean;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] bg-beast-600 text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] w-full">
        {message.tools && message.tools.length > 0 && (
          <details className="mb-2" open={live}>
            <summary className="text-xs text-gray-500 cursor-pointer select-none hover:text-gray-700">
              {message.tools.length} data {message.tools.length === 1 ? "lookup" : "lookups"}
            </summary>
            <ul className="mt-1 space-y-1">
              {message.tools.map((t, i) => (
                <li key={i} className="text-xs text-gray-500 flex items-center gap-2">
                  <span
                    className={`inline-block w-1.5 h-1.5 rounded-full ${
                      t.ms === undefined ? "bg-amber-400 animate-pulse" : t.ok ? "bg-green-500" : "bg-red-500"
                    }`}
                  />
                  <span>{t.summary}</span>
                  {t.ms !== undefined && <span className="text-gray-400">{(t.ms / 1000).toFixed(1)}s</span>}
                </li>
              ))}
            </ul>
          </details>
        )}

        {message.content ? (
          <div className="bg-gray-50 border border-gray-200 rounded-2xl rounded-bl-sm px-4 py-1">
            <Markdown text={message.content} />
          </div>
        ) : (
          live && (
            <div className="text-sm text-gray-500 flex items-center gap-2 px-1 py-2">
              <span className="inline-block w-2 h-2 rounded-full bg-beast-500 animate-pulse" />
              {status ?? "Thinking"}…
            </div>
          )
        )}

        {message.error && <div className="alert alert-error mt-2 text-sm">{message.error}</div>}
      </div>
    </div>
  );
}
