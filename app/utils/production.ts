import type { InventoryState, SkuType } from "@prisma/client";

// ============================================================================
// PRODUCTION MOVEMENT ENGINE (pure — no DB)
//
// Single source of truth for how producing one assembly moves inventory.
//
// CORE RULE: producing an assembly consumes ONLY its immediate BOM children
// (the prior stage's output), never the recursive raw-material explosion.
// Each child was itself produced (and its own children consumed) by an earlier
// stage's approval, so exploding to raw here double-counts. The recursive
// explosion belongs to PLANNING (build/forecast), not to MOVEMENT.
//
// Keeping this logic pure (a plain function over BOM data) is deliberate: it
// lets us unit-test the movement math without a database. The DB wrapper
// (applyProduction in inventory.server.ts) just persists the movements this
// function returns.
// ============================================================================

export type MovementReason = "CONSUMED" | "PRODUCED";

export interface Movement {
  skuId: string;
  /** negative = consume from stock, positive = add to stock */
  delta: number;
  state: InventoryState;
  reason: MovementReason;
}

export interface DirectBomLine {
  componentSkuId: string;
  componentType: SkuType;
  /** quantity of this component per 1 unit of the parent */
  quantity: number;
}

/**
 * The inventory state a SKU lives in when it is "available" to be used,
 * derived purely from its type. RAW parts sit in RAW, sub-assemblies in
 * ASSEMBLED, finished goods in COMPLETED.
 */
export function availableState(type: SkuType): InventoryState {
  return type === "RAW" ? "RAW" : type === "ASSEMBLY" ? "ASSEMBLED" : "COMPLETED";
}

/**
 * Plan the inventory movements for producing `qty` of one output SKU.
 *
 * Consumes each immediate BOM child from its available state and produces the
 * output into its available state. Single-level only — this is what makes the
 * perpetual count trustworthy and is the fix for the cross-path double-deduct.
 */
export function planProduction(
  output: { skuId: string; type: SkuType },
  qty: number,
  directBom: DirectBomLine[]
): Movement[] {
  if (qty <= 0) return [];

  const moves: Movement[] = [];

  // Consume each immediate child (one level down — NOT the recursive explosion).
  for (const line of directBom) {
    moves.push({
      skuId: line.componentSkuId,
      delta: -(line.quantity * qty),
      state: availableState(line.componentType),
      reason: "CONSUMED",
    });
  }

  // Produce the output into the state its type dictates.
  moves.push({
    skuId: output.skuId,
    delta: qty,
    state: availableState(output.type),
    reason: "PRODUCED",
  });

  return moves;
}
