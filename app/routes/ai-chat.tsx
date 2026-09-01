import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { useEffect, useRef, useState } from "react";
import { requireRole } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import { Markdown } from "../components/Markdown";
import { isAiConfigured } from "../utils/ai-chat.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN", "MANAGER"]);
  return { user, configured: isAiConfigured() };
};

type ToolTrace = { name: string; summary: string; ms?: number; ok?: boolean };
type Message = {
  role: "user" | "assistant";
  content: string;
  tools?: ToolTrace[];
  error?: string;
};

const STORAGE_KEY = "beast-ai-chat";

const SUGGESTIONS = [
  "What's short right now if we had to fill every unfulfilled order today?",
  "How many 100 grain 3-packs can we build with what's on the floor?",
  "If we needed to build 5,000 broadheads next month, what would we run out of first?",
  "What's the oldest unfulfilled order and what's holding it up?",
  "Which raw materials are on order and when do they land?",
  "How many units did we produce per process last week?",
];

export default function AiChat() {
  const { user, configured } = useLoaderData<typeof loader>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState<Message | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Restore the transcript so a refresh doesn't wipe the conversation.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setMessages(JSON.parse(saved));
    } catch {
      /* corrupt or unavailable storage — start clean */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-40)));
    } catch {
      /* quota or private mode — the chat still works, it just won't persist */
    }
  }, [messages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, streaming, status]);

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;

    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [...prev, { role: "user", content: q }]);
    setInput("");
    setBusy(true);
    setStatus("Thinking");
    const live: Message = { role: "assistant", content: "", tools: [] };
    setStreaming({ ...live });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/ai-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, history }),
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
          if (event.type === "delta") {
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
    }
  };

  const stop = () => abortRef.current?.abort();
  const clear = () => {
    setMessages([]);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* nothing to clear */
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ask(input);
    }
  };

  return (
    <Layout user={user}>
      <div className="page-header flex items-start justify-between">
        <div>
          <h1 className="page-title">AI Chat</h1>
          <p className="page-subtitle">
            Ask about inventory, orders, production, and what-ifs. It reads live data and can't change anything.
          </p>
        </div>
        {messages.length > 0 && (
          <button onClick={clear} className="btn btn-ghost btn-sm" disabled={busy}>
            New chat
          </button>
        )}
      </div>

      {!configured && (
        <div className="alert alert-warning mb-4">
          <strong>Not configured.</strong> Set <code>ANTHROPIC_API_KEY</code> in this
          environment (Render dashboard in production, <code>.env</code> locally) and restart.
        </div>
      )}

      <div className="card">
        <div className="card-body min-h-[55vh] max-h-[70vh] overflow-y-auto" id="ai-chat-scroll">
          {messages.length === 0 && !streaming && (
            <div className="py-6">
              <p className="text-sm font-medium text-gray-900 mb-1">Try one of these</p>
              <p className="text-sm text-gray-500 mb-4">
                Or ask anything about SKUs, POs, transfers, unfulfilled orders, or build capacity.
              </p>
              <div className="grid gap-2 md:grid-cols-2">
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
              disabled={!configured}
              placeholder="Ask about inventory, orders, or a what-if…"
              className="form-textarea flex-1 resize-none"
            />
            {busy ? (
              <button onClick={stop} className="btn btn-secondary">
                Stop
              </button>
            ) : (
              <button
                onClick={() => ask(input)}
                disabled={!input.trim() || !configured}
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

        {message.error && (
          <div className="alert alert-error mt-2 text-sm">{message.error}</div>
        )}
      </div>
    </div>
  );
}
