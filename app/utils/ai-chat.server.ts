// ============================================================================
// AI CHAT — the agent loop behind /ai-chat
//
// A manual tool-use loop against the Messages API. Manual (rather than the
// SDK tool runner) because the UI streams progress: every tool call is
// announced to the browser as it happens, so a question that takes four
// lookups shows its work instead of spinning.
//
// The loop is read-only end to end — see ai-tools.server.ts.
// ============================================================================

import Anthropic from "@anthropic-ai/sdk";
import { AI_TOOLS, runAiTool } from "./ai-tools.server";

export const AI_CHAT_MODEL = "claude-opus-5";

/** How many assistant turns (tool rounds) one question may take. */
const MAX_ITERATIONS = 12;

export type ChatTurn = { role: "user" | "assistant"; content: string };

/** Events streamed to the browser as newline-delimited JSON. */
export type ChatEvent =
  | { type: "conversation"; id: string; title: string }
  | { type: "status"; status: "thinking" | "working" }
  | { type: "tool"; name: string; summary: string }
  | { type: "tool_done"; name: string; ms: number; ok: boolean }
  | { type: "delta"; text: string }
  | { type: "done"; usage?: { input: number; output: number } }
  | { type: "error"; message: string };

export function isAiConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

function systemPrompt(): Anthropic.TextBlockParam[] {
  const today = new Date().toISOString().split("T")[0];
  return [
    {
      type: "text",
      text: `You are the inventory analyst for Beast Broadheads, working inside the Beast Inventory System. You answer questions from the owner and floor managers about inventory, production, orders, and what-if planning.

HOW THE BUSINESS WORKS
- Broadheads are manufactured in the Utah facility. Raw parts are purchased on POs, received, then worked through a chain of processes (for example tipping, blading, stud testing, packing). Each process consumes the previous stage's output and produces the next.
- SKU types: RAW (purchased parts), ASSEMBLY (sub-assemblies built in house), COMPLETED (finished, sellable goods).
- Inventory states: RECEIVED (arrived, not signed off yet), RAW, ASSEMBLED, COMPLETED, TRANSFERRED (already shipped out of Utah).
- Finished goods are transferred from Utah to the Gallatin fulfillment warehouse (ShipHero, warehouse "Apex"). Gallatin on-hand is what can actually ship to a customer today; Utah COMPLETED is finished stock that still has to be transferred.
- Customer demand comes from two Shopify stores (Bowmar Archery and Beast Broadhead) plus programmed/scheduled dealer orders from the Queued Orders app.
- Orders can ship from Gallatin (ShipHero) or in house from Utah.

HOW TO ANSWER
- Every number must come from a tool call. Never estimate, recall, or carry a number over from earlier in the conversation without re-checking it if it matters.
- SKU is the join key. Product names change; SKUs do not. When the user names a product loosely, use search_skus first and confirm which SKU you used.
- For hypotheticals ("if we had to build 5,000 of X"), use simulate_build. It draws every product from one shared stock pool, so shared parts are not promised twice. Report what is short, by how much, and the labor hours it would take.
- Show the arithmetic behind a conclusion in one line when it matters (for example: 4,200 needed − 1,150 on hand = 3,050 short).
- Say the date range and the source you used. "Unfulfilled units" is live Shopify; "produced" is approved worker time entries; "on hand" is either Utah floor count or live Gallatin, and they are different things — always say which.
- If a tool comes back with an error (an integration is down, a SKU does not exist), say so plainly and answer with what you do have. Do not paper over a gap.
- Be direct and brief. Lead with the answer, then the supporting numbers. Use a markdown table when comparing more than about three rows. No preamble, no restating the question.
- You are read-only. You cannot create POs, move inventory, approve time, or change anything. If asked to, say what you would do and where in the app to do it.

Today's date is ${today}.`,
      cache_control: { type: "ephemeral" },
    },
  ];
}

/** A short human-readable label for a tool call, shown live in the UI. */
function summarizeToolCall(name: string, input: any): string {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (name) {
    case "search_skus":
      return s(input?.query) ? `Searching SKUs for "${input.query}"` : "Listing SKUs";
    case "get_inventory":
      return `Checking inventory${input?.include_gallatin ? " (incl. Gallatin)" : ""}`;
    case "get_sku_detail":
      return `Looking up ${s(input?.sku)}`;
    case "get_unfulfilled_orders":
      return "Reading unfulfilled Shopify orders";
    case "get_programmed_orders":
      return "Reading programmed dealer orders";
    case "get_build_capacity":
      return s(input?.sku) ? `Build capacity for ${input.sku}` : "Build capacity across products";
    case "simulate_build": {
      const items = Array.isArray(input?.items) ? input.items : [];
      const first = items[0];
      const extra = items.length > 1 ? ` +${items.length - 1} more` : "";
      return first ? `Simulating build of ${first.quantity} × ${first.sku}${extra}` : "Simulating a build";
    }
    case "get_purchase_orders":
      return "Checking purchase orders";
    case "get_work_orders":
      return "Checking work orders";
    case "get_transfers":
      return "Checking transfers to Gallatin";
    case "get_production_history":
      return "Reading approved production history";
    case "get_inventory_movements":
      return "Reading the inventory audit trail";
    case "get_fulfilled_orders":
      return "Reading shipped orders from Shopify";
    case "get_labor_capacity":
      return "Checking process times and scheduled labor";
    default:
      return `Running ${name}`;
  }
}

/**
 * Run one question to completion, emitting progress events as it goes.
 * `history` is the plain-text transcript of earlier turns; tool traffic is not
 * replayed across turns, which keeps the context small — if a follow-up needs a
 * number again, the model simply looks it up again.
 */
export async function streamChatAnswer(
  question: string,
  history: ChatTurn[],
  emit: (event: ChatEvent) => void
): Promise<void> {
  if (!isAiConfigured()) {
    emit({
      type: "error",
      message: "ANTHROPIC_API_KEY is not set on this server, so the chat can't run.",
    });
    return;
  }

  const client = new Anthropic();

  // Keep the last 20 turns so a long session doesn't grow without bound, and
  // drop any assistant turn left at the front by that trim — the conversation
  // has to start on a user message.
  const trimmed = history.slice(-20);
  while (trimmed.length > 0 && trimmed[0].role === "assistant") trimmed.shift();

  const messages: Anthropic.MessageParam[] = [
    ...trimmed.map((t) => ({ role: t.role, content: t.content })),
    { role: "user" as const, content: question },
  ];

  let inputTokens = 0;
  let outputTokens = 0;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    emit({ type: "status", status: iteration === 0 ? "thinking" : "working" });

    const stream = client.messages.stream({
      model: AI_CHAT_MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: systemPrompt(),
      tools: AI_TOOLS,
      messages,
    });

    stream.on("text", (delta) => emit({ type: "delta", text: delta }));

    const message = await stream.finalMessage();
    inputTokens += message.usage.input_tokens ?? 0;
    outputTokens += message.usage.output_tokens ?? 0;

    // A server-side tool paused the turn — hand the assistant turn back to continue.
    if (message.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: message.content });
      continue;
    }

    const toolUses = message.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    if (toolUses.length === 0) {
      emit({ type: "done", usage: { input: inputTokens, output: outputTokens } });
      return;
    }

    // Echo the assistant turn back verbatim (thinking blocks included) — the
    // API requires the exact blocks when continuing a tool-use turn.
    messages.push({ role: "assistant", content: message.content });

    for (const call of toolUses) {
      emit({ type: "tool", name: call.name, summary: summarizeToolCall(call.name, call.input) });
    }

    // Tools are independent and read-only, so run them concurrently and return
    // every result in ONE user message (splitting them would train the model
    // out of making parallel calls).
    const results = await Promise.all(
      toolUses.map(async (call) => {
        const startedAt = Date.now();
        const { ok, result } = await runAiTool(call.name, call.input);
        emit({ type: "tool_done", name: call.name, ms: Date.now() - startedAt, ok });
        return {
          type: "tool_result" as const,
          tool_use_id: call.id,
          content: result,
          ...(ok ? {} : { is_error: true }),
        };
      })
    );
    messages.push({ role: "user", content: results });
  }

  emit({
    type: "error",
    message: `Stopped after ${MAX_ITERATIONS} rounds of lookups without finishing. Try narrowing the question.`,
  });
}
