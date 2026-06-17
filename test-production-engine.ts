// Pure (no-DB) test for the production movement engine.
// Run: node test-production-engine.ts
//
// Proves:
//   1. The OLD recursive "explode to raw at every stage" strategy DOUBLE-COUNTS
//      raw materials and leaves phantom work-in-progress. (reproduction)
//   2. planProduction() (single-level, immediate children only) consumes each
//      raw exactly once and nets WIP to zero. (the fix)

import type { SkuType, InventoryState } from "@prisma/client";
import { planProduction, type DirectBomLine, type Movement } from "./app/utils/production.ts";

// --- tiny in-memory BOM + inventory simulator -------------------------------

type Bom = Record<string, { type: SkuType; children: DirectBomLine[] }>;

const T = (type: SkuType, children: DirectBomLine[] = []) => ({ type, children });
const c = (componentSkuId: string, componentType: SkuType, quantity: number): DirectBomLine => ({
  componentSkuId,
  componentType,
  quantity,
});

// Broadhead chain (trimmed): raw ferrule + tip -> TIPPED -> (+blades+pin) BLADED
const BOM: Bom = {
  FERRULE: T("RAW"),
  TIP: T("RAW"),
  BLADE: T("RAW"),
  PIN: T("RAW"),
  TIPPED: T("ASSEMBLY", [c("FERRULE", "RAW", 1), c("TIP", "RAW", 1)]),
  BLADED: T("ASSEMBLY", [c("TIPPED", "ASSEMBLY", 1), c("BLADE", "RAW", 2), c("PIN", "RAW", 1)]),
};

// Track gross consumption per raw SKU, and net on-hand per SKU.
function freshLedger() {
  return { consumed: {} as Record<string, number>, onHand: {} as Record<string, number> };
}
type Ledger = ReturnType<typeof freshLedger>;

function apply(ledger: Ledger, moves: Movement[]) {
  for (const m of moves) {
    ledger.onHand[m.skuId] = (ledger.onHand[m.skuId] ?? 0) + m.delta;
    if (m.delta < 0) ledger.consumed[m.skuId] = (ledger.consumed[m.skuId] ?? 0) + -m.delta;
  }
}

// --- strategy A: single-level (the engine under test) -----------------------

function produceSingleLevel(ledger: Ledger, outputSkuId: string, qty: number) {
  const node = BOM[outputSkuId];
  apply(ledger, planProduction({ skuId: outputSkuId, type: node.type }, qty, node.children));
}

// --- strategy B: the OLD buggy recursive explode-to-raw ----------------------

function explodeToRaw(skuId: string, qty: number, out: Record<string, number>) {
  const node = BOM[skuId];
  if (node.type === "RAW") {
    out[skuId] = (out[skuId] ?? 0) + qty;
    return;
  }
  for (const child of node.children) explodeToRaw(child.componentSkuId, child.quantity * qty, out);
}

function produceRecursive(ledger: Ledger, outputSkuId: string, qty: number) {
  const raws: Record<string, number> = {};
  explodeToRaw(outputSkuId, qty, raws);
  const moves: Movement[] = [];
  for (const [skuId, q] of Object.entries(raws)) {
    moves.push({ skuId, delta: -q, state: "RAW" as InventoryState, reason: "CONSUMED" });
  }
  moves.push({
    skuId: outputSkuId,
    delta: qty,
    state: BOM[outputSkuId].type === "COMPLETED" ? "COMPLETED" : "ASSEMBLED",
    reason: "PRODUCED",
  });
  apply(ledger, moves);
}

// --- assertions -------------------------------------------------------------

let failures = 0;
function expect(label: string, actual: number, expected: number) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}: got ${actual}, expected ${expected}`);
}

// Scenario: one worker tips 100, another blades 100 (consuming the 100 tips).
const QTY = 100;

console.log("\n[Strategy B] OLD recursive explode-to-raw at every stage (the bug):");
const buggy = freshLedger();
produceRecursive(buggy, "TIPPED", QTY);
produceRecursive(buggy, "BLADED", QTY);
expect("FERRULE consumed (double-counted)", buggy.consumed.FERRULE ?? 0, 200);
expect("TIP consumed (double-counted)", buggy.consumed.TIP ?? 0, 200);
expect("TIPPED phantom WIP left on hand", buggy.onHand.TIPPED ?? 0, 100);

console.log("\n[Strategy A] planProduction single-level (the fix):");
const fixed = freshLedger();
produceSingleLevel(fixed, "TIPPED", QTY);
produceSingleLevel(fixed, "BLADED", QTY);
expect("FERRULE consumed (each raw once)", fixed.consumed.FERRULE ?? 0, 100);
expect("TIP consumed (each raw once)", fixed.consumed.TIP ?? 0, 100);
expect("BLADE consumed (2 per bladed)", fixed.consumed.BLADE ?? 0, 200);
expect("TIPPED nets to zero (no phantom WIP)", fixed.onHand.TIPPED ?? 0, 0);
expect("BLADED produced", fixed.onHand.BLADED ?? 0, 100);

console.log("\n[Diff] the bug, quantified:");
expect(
  "old strategy consumes 2x the ferrules of the fix",
  buggy.consumed.FERRULE ?? 0,
  (fixed.consumed.FERRULE ?? 0) * 2
);

console.log(`\n${failures === 0 ? "✅ ALL PASSED" : `❌ ${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
