import prisma from "../db.server";
import type { InventoryState, SkuType, Prisma } from "@prisma/client";
import { planProduction, availableState, type DirectBomLine } from "./production";

// Type for Prisma client or transaction
type PrismaClientOrTx = typeof prisma | Prisma.TransactionClient;

// ============================================
// TYPES
// ============================================

export interface InventorySummary {
  skuId: string;
  sku: string;
  name: string;
  type: SkuType;
  received: number;    // Pending sign-off
  available: number;   // Ready to use (RAW, ASSEMBLED, or COMPLETED depending on type)
  total: number;
}

export interface BuildEligibility {
  skuId: string;
  sku: string;
  name: string;
  type: SkuType;
  maxBuildable: number;
  bottleneck: {
    sku: string;
    name: string;
    available: number;
    required: number;
    shortfall: number;
  } | null;
  components: {
    sku: string;
    name: string;
    required: number;
    available: number;
    canSupply: number;
  }[];
}

export interface ComponentRequirement {
  skuId: string;
  sku: string;
  name: string;
  quantityPerUnit: number;
  totalRequired: number;
  available: number;
  shortfall: number;
}

// ============================================
// GET INVENTORY LEVELS
// ============================================

/**
 * Get the available quantity for a SKU in a specific state
 */
export async function getAvailableQuantity(
  skuId: string,
  states: InventoryState[]
): Promise<number> {
  const result = await prisma.inventoryItem.aggregate({
    where: {
      skuId,
      state: { in: states },
    },
    _sum: {
      quantity: true,
    },
  });
  return result._sum.quantity || 0;
}

/**
 * Get inventory summary for all SKUs
 */
export async function getInventorySummary(): Promise<InventorySummary[]> {
  // Get all SKUs with their inventory
  const skus = await prisma.sku.findMany({
    where: { isActive: true },
    include: {
      inventoryItems: true,
    },
    orderBy: [{ type: "asc" }, { sku: "asc" }],
  });

  return skus.map((sku) => {
    const received = sku.inventoryItems
      .filter((i) => i.state === "RECEIVED")
      .reduce((sum, i) => sum + i.quantity, 0);

    // Available state depends on SKU type
    const availableStates: InventoryState[] =
      sku.type === "RAW"
        ? ["RAW"]
        : sku.type === "ASSEMBLY"
        ? ["ASSEMBLED"]
        : ["COMPLETED"];

    const available = sku.inventoryItems
      .filter((i) => availableStates.includes(i.state))
      .reduce((sum, i) => sum + i.quantity, 0);

    return {
      skuId: sku.id,
      sku: sku.sku,
      name: sku.name,
      type: sku.type,
      received,
      available,
      total: received + available,
    };
  });
}

/**
 * Get inventory for a specific SKU
 */
export async function getSkuInventory(skuId: string): Promise<{
  sku: { id: string; sku: string; name: string; type: SkuType };
  byState: Record<InventoryState, number>;
  total: number;
}> {
  const sku = await prisma.sku.findUnique({
    where: { id: skuId },
    include: { inventoryItems: true },
  });

  if (!sku) {
    throw new Error(`SKU not found: ${skuId}`);
  }

  const byState: Record<InventoryState, number> = {
    RECEIVED: 0,
    RAW: 0,
    ASSEMBLED: 0,
    COMPLETED: 0,
    TRANSFERRED: 0,
  };

  for (const item of sku.inventoryItems) {
    byState[item.state] += item.quantity;
  }

  const total = Object.values(byState).reduce((sum, qty) => sum + qty, 0);

  return {
    sku: { id: sku.id, sku: sku.sku, name: sku.name, type: sku.type },
    byState,
    total,
  };
}

// ============================================
// BUILD ELIGIBILITY CALCULATION
// ============================================

/**
 * Calculate how many units of a SKU can be built from available inventory
 */
export async function calculateBuildEligibility(
  skuId: string
): Promise<BuildEligibility> {
  // Get the SKU and its BOM
  const sku = await prisma.sku.findUnique({
    where: { id: skuId },
    include: {
      bomComponents: {
        include: {
          componentSku: true,
        },
      },
    },
  });

  if (!sku) {
    throw new Error(`SKU not found: ${skuId}`);
  }

  if (sku.bomComponents.length === 0) {
    // This is a raw material or has no BOM - can't be built
    return {
      skuId: sku.id,
      sku: sku.sku,
      name: sku.name,
      type: sku.type,
      maxBuildable: 0,
      bottleneck: null,
      components: [],
    };
  }

  // Get available quantity for each component
  const components: BuildEligibility["components"] = [];
  let minBuildable = Infinity;
  let bottleneckComponent: BuildEligibility["bottleneck"] = null;

  for (const bomItem of sku.bomComponents) {
    const componentSku = bomItem.componentSku;

    // Determine which inventory states count as "available" for this component
    const availableStates: InventoryState[] =
      componentSku.type === "RAW"
        ? ["RAW"]
        : componentSku.type === "ASSEMBLY"
        ? ["ASSEMBLED"]
        : ["COMPLETED"];

    const available = await getAvailableQuantity(componentSku.id, availableStates);
    const canSupply = Math.floor(available / bomItem.quantity);

    components.push({
      sku: componentSku.sku,
      name: componentSku.name,
      required: bomItem.quantity,
      available,
      canSupply,
    });

    if (canSupply < minBuildable) {
      minBuildable = canSupply;
      bottleneckComponent = {
        sku: componentSku.sku,
        name: componentSku.name,
        available,
        required: bomItem.quantity,
        shortfall: available < bomItem.quantity ? bomItem.quantity - available : 0,
      };
    }
  }

  // If any component has 0 available, maxBuildable is 0
  if (minBuildable === Infinity) {
    minBuildable = 0;
  }

  return {
    skuId: sku.id,
    sku: sku.sku,
    name: sku.name,
    type: sku.type,
    maxBuildable: minBuildable,
    bottleneck: minBuildable === 0 ? bottleneckComponent : bottleneckComponent,
    components,
  };
}

/**
 * Get build eligibility for all buildable SKUs (assemblies and completed)
 */
export async function getAllBuildEligibility(): Promise<BuildEligibility[]> {
  const buildableSkus = await prisma.sku.findMany({
    where: {
      isActive: true,
      type: { in: ["ASSEMBLY", "COMPLETED"] },
      bomComponents: { some: {} }, // Has at least one BOM component
    },
  });

  const eligibilities: BuildEligibility[] = [];

  for (const sku of buildableSkus) {
    const eligibility = await calculateBuildEligibility(sku.id);
    eligibilities.push(eligibility);
  }

  // Sort by maxBuildable descending
  eligibilities.sort((a, b) => b.maxBuildable - a.maxBuildable);

  return eligibilities;
}

/**
 * Calculate what components are needed to build a quantity of a SKU
 * (flattens the entire BOM tree to raw materials)
 */
export async function calculateTotalRequirements(
  skuId: string,
  quantity: number
): Promise<ComponentRequirement[]> {
  const requirements = new Map<string, ComponentRequirement>();

  async function traverseBom(currentSkuId: string, multiplier: number) {
    const sku = await prisma.sku.findUnique({
      where: { id: currentSkuId },
      include: {
        bomComponents: {
          include: { componentSku: true },
        },
      },
    });

    if (!sku) return;

    for (const bomItem of sku.bomComponents) {
      const componentSku = bomItem.componentSku;
      const requiredQty = bomItem.quantity * multiplier;

      if (componentSku.type === "RAW") {
        // Raw material - add to requirements
        const existing = requirements.get(componentSku.id);
        if (existing) {
          existing.totalRequired += requiredQty;
        } else {
          const available = await getAvailableQuantity(componentSku.id, ["RAW"]);
          requirements.set(componentSku.id, {
            skuId: componentSku.id,
            sku: componentSku.sku,
            name: componentSku.name,
            quantityPerUnit: bomItem.quantity,
            totalRequired: requiredQty,
            available,
            shortfall: 0, // Will be calculated later
          });
        }
      } else {
        // Assembly - recurse into its components
        await traverseBom(componentSku.id, requiredQty);
      }
    }
  }

  await traverseBom(skuId, quantity);

  // Calculate shortfalls
  const result = Array.from(requirements.values());
  for (const req of result) {
    req.shortfall = Math.max(0, req.totalRequired - req.available);
  }

  return result.sort((a, b) => a.sku.localeCompare(b.sku));
}

// ============================================
// INVENTORY MUTATIONS
// ============================================

/**
 * Log inventory movement
 * @param client - Optional Prisma client or transaction. Uses global prisma if not provided.
 */
export async function logInventoryMovement(
  skuId: string,
  action: "RECEIVED" | "CONSUMED" | "PRODUCED" | "TRANSFERRED_OUT" | "TRANSFERRED_IN" | "ADJUSTED" | "DISPOSED",
  quantity: number,
  fromState?: InventoryState,
  toState?: InventoryState,
  relatedResource?: string,
  relatedResourceType?: string,
  processName?: string,
  notes?: string,
  performedById?: string,
  client?: PrismaClientOrTx
): Promise<void> {
  const db = client || prisma;
  await db.inventoryLog.create({
    data: {
      skuId,
      action,
      quantity,
      fromState: fromState || null,
      toState: toState || null,
      relatedResource: relatedResource || null,
      relatedResourceType: relatedResourceType || null,
      processName: processName || null,
      notes: notes || null,
      performedById: performedById || null,
    },
  });
}

/**
 * Add inventory (used when receiving is signed off or build completes)
 * @param client - Optional Prisma client or transaction. Uses global prisma if not provided.
 */
export async function addInventory(
  skuId: string,
  quantity: number,
  state: InventoryState,
  location?: string,
  notes?: string,
  relatedResource?: string,
  relatedResourceType?: string,
  processName?: string,
  performedById?: string,
  client?: PrismaClientOrTx
): Promise<void> {
  const db = client || prisma;
  console.log(`[addInventory] Called with: skuId=${skuId}, quantity=${quantity}, state=${state}, location=${location}, usingTx=${!!client}`);

  // Check if there's an existing inventory item for this SKU/state/location
  const existing = await db.inventoryItem.findFirst({
    where: {
      skuId,
      state,
      location: location || null,
    },
  });

  console.log(`[addInventory] Existing item found: ${existing ? `id=${existing.id}, qty=${existing.quantity}` : 'none'}`);

  if (existing) {
    // Update existing
    const newQty = existing.quantity + quantity;
    console.log(`[addInventory] Updating existing: ${existing.quantity} + ${quantity} = ${newQty}`);
    await db.inventoryItem.update({
      where: { id: existing.id },
      data: { quantity: newQty },
    });
    console.log(`[addInventory] Update complete`);
  } else {
    // Create new
    console.log(`[addInventory] Creating new inventory item`);
    await db.inventoryItem.create({
      data: {
        skuId,
        quantity,
        state,
        location,
        notes,
      },
    });
    console.log(`[addInventory] Create complete`);
  }

  // Log the inventory movement
  const action = relatedResourceType === "PURCHASE_ORDER" ? "RECEIVED" :
                 relatedResourceType === "TRANSFER" ? "TRANSFERRED_IN" :
                 "PRODUCED";

  await logInventoryMovement(
    skuId,
    action,
    quantity,
    undefined,
    state,
    relatedResource,
    relatedResourceType,
    processName,
    notes,
    performedById,
    db
  );
}

/**
 * Deduct inventory (used when consuming components in a build or transferring)
 * For RAW materials, allows negative inventory to support incremental worker task submissions
 * @param client - Optional Prisma client or transaction. Uses global prisma if not provided.
 */
export async function deductInventory(
  skuId: string,
  quantity: number,
  states: InventoryState[],
  relatedResource?: string,
  relatedResourceType?: string,
  processName?: string,
  performedById?: string,
  client?: PrismaClientOrTx
): Promise<{ success: boolean; error?: string }> {
  const db = client || prisma;
  console.log(`[deductInventory] Called with: skuId=${skuId}, quantity=${quantity}, states=${states.join(",")}, usingTx=${!!client}`);

  // Get available inventory items for this SKU in the specified states
  const items = await db.inventoryItem.findMany({
    where: {
      skuId,
      state: { in: states },
      quantity: { gt: 0 },
    },
    orderBy: { createdAt: "asc" }, // FIFO
  });

  const totalAvailable = items.reduce((sum, i) => sum + i.quantity, 0);
  console.log(`[deductInventory] Found ${items.length} items with total available: ${totalAvailable}`);

  // Allow negative inventory for RAW, ASSEMBLED, and COMPLETED states
  // This supports incremental worker task submissions where assemblies are used before recorded
  const allowNegative = states.includes("RAW") || states.includes("ASSEMBLED") || states.includes("COMPLETED");

  if (!allowNegative && totalAvailable < quantity) {
    return {
      success: false,
      error: `Insufficient inventory. Need ${quantity}, have ${totalAvailable}`,
    };
  }

  // Deduct from items in FIFO order
  let remaining = quantity;
  for (const item of items) {
    if (remaining <= 0) break;

    const toDeduct = Math.min(item.quantity, remaining);
    const newQty = item.quantity - toDeduct;

    if (newQty === 0) {
      await db.inventoryItem.delete({ where: { id: item.id } });
    } else {
      await db.inventoryItem.update({
        where: { id: item.id },
        data: { quantity: newQty },
      });
    }

    remaining -= toDeduct;
  }

  // If we still have remaining quantity to deduct and we allow negative
  // (RAW, ASSEMBLED, or COMPLETED materials), create a negative inventory item
  if (remaining > 0 && allowNegative) {
    // Find or create a negative inventory item for this SKU/state
    const negativeItem = await db.inventoryItem.findFirst({
      where: {
        skuId,
        state: { in: states },
      },
    });

    if (negativeItem) {
      // Update existing item to go more negative
      await db.inventoryItem.update({
        where: { id: negativeItem.id },
        data: { quantity: negativeItem.quantity - remaining },
      });
    } else {
      // Create new negative inventory item
      await db.inventoryItem.create({
        data: {
          skuId,
          quantity: -remaining,
          state: states[0], // Use the first state from the states array
        },
      });
    }
  }

  // Log the inventory movement
  const action = relatedResourceType === "TRANSFER" ? "TRANSFERRED_OUT" : "CONSUMED";

  await logInventoryMovement(
    skuId,
    action,
    quantity,
    states[0],
    undefined,
    relatedResource,
    relatedResourceType,
    processName,
    undefined,
    performedById,
    db
  );

  return { success: true };
}

/**
 * Execute a build - consume components and create output
 *
 * @deprecated Production should move inventory through ONE path: applyProduction()
 * on QC approval (see PRODUCTION-PROCESS.md §1). This work-order path is a second
 * way to record the same production and can double-count. Kept for now; to be
 * rewired or retired in the path-consolidation step.
 */
export async function executeBuild(
  workOrderId: string,
  quantityToBuild: number
): Promise<{ success: boolean; error?: string }> {
  const workOrder = await prisma.workOrder.findUnique({
    where: { id: workOrderId },
    include: {
      outputSku: {
        include: {
          bomComponents: {
            include: { componentSku: true },
          },
        },
      },
    },
  });

  if (!workOrder) {
    return { success: false, error: "Work order not found" };
  }

  // Verify we have enough components
  for (const bomItem of workOrder.outputSku.bomComponents) {
    const componentSku = bomItem.componentSku;
    const availableStates: InventoryState[] =
      componentSku.type === "RAW" ? ["RAW"] : ["ASSEMBLED"];

    const available = await getAvailableQuantity(componentSku.id, availableStates);
    const needed = bomItem.quantity * quantityToBuild;

    if (available < needed) {
      return {
        success: false,
        error: `Insufficient ${componentSku.sku}. Need ${needed}, have ${available}`,
      };
    }
  }

  // Execute the build in a transaction
  await prisma.$transaction(async (tx) => {
    // Deduct components
    for (const bomItem of workOrder.outputSku.bomComponents) {
      const componentSku = bomItem.componentSku;
      const availableStates: InventoryState[] =
        componentSku.type === "RAW" ? ["RAW"] : ["ASSEMBLED"];

      const quantityToDeduct = bomItem.quantity * quantityToBuild;

      // Deduct inventory
      const items = await tx.inventoryItem.findMany({
        where: {
          skuId: componentSku.id,
          state: { in: availableStates },
          quantity: { gt: 0 },
        },
        orderBy: { createdAt: "asc" },
      });

      let remaining = quantityToDeduct;
      for (const item of items) {
        if (remaining <= 0) break;

        const toDeduct = Math.min(item.quantity, remaining);
        const newQty = item.quantity - toDeduct;

        if (newQty === 0) {
          await tx.inventoryItem.delete({ where: { id: item.id } });
        } else {
          await tx.inventoryItem.update({
            where: { id: item.id },
            data: { quantity: newQty },
          });
        }

        remaining -= toDeduct;
      }

      // Record consumption
      await tx.workOrderConsumption.create({
        data: {
          workOrderId,
          skuId: componentSku.id,
          quantity: quantityToDeduct,
        },
      });
    }

    // Add the output inventory
    const outputState: InventoryState =
      workOrder.outputSku.type === "ASSEMBLY" ? "ASSEMBLED" : "COMPLETED";

    const existingOutput = await tx.inventoryItem.findFirst({
      where: {
        skuId: workOrder.outputSkuId,
        state: outputState,
      },
    });

    if (existingOutput) {
      await tx.inventoryItem.update({
        where: { id: existingOutput.id },
        data: { quantity: existingOutput.quantity + quantityToBuild },
      });
    } else {
      await tx.inventoryItem.create({
        data: {
          skuId: workOrder.outputSkuId,
          quantity: quantityToBuild,
          state: outputState,
        },
      });
    }

    // Update work order
    const newQuantityBuilt = workOrder.quantityBuilt + quantityToBuild;
    const isComplete = newQuantityBuilt >= workOrder.quantityToBuild;

    await tx.workOrder.update({
      where: { id: workOrderId },
      data: {
        quantityBuilt: newQuantityBuilt,
        status: isComplete ? "COMPLETED" : "IN_PROGRESS",
        startedAt: workOrder.startedAt || new Date(),
        completedAt: isComplete ? new Date() : null,
      },
    });
  });

  return { success: true };
}

// ============================================
// PRODUCTION ENGINE (single source of truth)
// ============================================

/** Add `qty` of a SKU into one state (merging into the default-location row). */
async function addStock(
  db: PrismaClientOrTx,
  skuId: string,
  qty: number,
  state: InventoryState
): Promise<void> {
  const existing = await db.inventoryItem.findFirst({
    where: { skuId, state, location: null },
  });
  if (existing) {
    await db.inventoryItem.update({
      where: { id: existing.id },
      data: { quantity: existing.quantity + qty },
    });
  } else {
    await db.inventoryItem.create({ data: { skuId, quantity: qty, state } });
  }
}

/**
 * FIFO-deduct `qty` of a SKU from one state. Allows going negative (a negative
 * means a real discrepancy we want to SEE, not block the floor over) but
 * reports how short it was so the caller can warn.
 */
async function deductStockFifo(
  db: PrismaClientOrTx,
  skuId: string,
  qty: number,
  state: InventoryState
): Promise<{ shortBy: number }> {
  const items = await db.inventoryItem.findMany({
    where: { skuId, state, quantity: { gt: 0 } },
    orderBy: { createdAt: "asc" },
  });
  const available = items.reduce((sum, i) => sum + i.quantity, 0);

  let remaining = qty;
  for (const item of items) {
    if (remaining <= 0) break;
    const toDeduct = Math.min(item.quantity, remaining);
    const newQty = item.quantity - toDeduct;
    if (newQty === 0) {
      await db.inventoryItem.delete({ where: { id: item.id } });
    } else {
      await db.inventoryItem.update({ where: { id: item.id }, data: { quantity: newQty } });
    }
    remaining -= toDeduct;
  }

  if (remaining > 0) {
    const anyRow = await db.inventoryItem.findFirst({ where: { skuId, state } });
    if (anyRow) {
      await db.inventoryItem.update({
        where: { id: anyRow.id },
        data: { quantity: anyRow.quantity - remaining },
      });
    } else {
      await db.inventoryItem.create({ data: { skuId, quantity: -remaining, state } });
    }
  }

  return { shortBy: Math.max(0, qty - available) };
}

export interface ApplyProductionResult {
  success: boolean;
  error?: string;
  /** Non-fatal notices, e.g. a component that went negative. */
  warnings: string[];
}

/**
 * THE single inventory-movement path for production. Producing `qty` of an
 * assembly consumes ONLY its immediate BOM children (each from the state its
 * type dictates) and adds the output to its own state. No recursive BOM
 * explosion here — that belongs to planning, and mixing the two is the
 * double-deduction bug this engine replaces.
 *
 * @param opts.produce  set false to consume children without producing output
 *                      (used for rejected/scrapped attempts — see PRODUCTION-PROCESS.md §4).
 * @param opts.consumeAction  ledger action for the consume rows (CONSUMED for good
 *                            production, DISPOSED for scrap).
 */
export async function applyProduction(
  outputSkuId: string,
  qty: number,
  opts: {
    produce?: boolean;
    consumeAction?: "CONSUMED" | "DISPOSED";
    relatedResource?: string;
    relatedResourceType?: string;
    processName?: string;
    performedById?: string;
    notes?: string;
  },
  client?: PrismaClientOrTx
): Promise<ApplyProductionResult> {
  const db = client || prisma;
  const warnings: string[] = [];
  if (qty <= 0) return { success: true, warnings };

  const produce = opts.produce !== false;
  const consumeAction = opts.consumeAction ?? "CONSUMED";

  const output = await db.sku.findUnique({
    where: { id: outputSkuId },
    include: { bomComponents: { include: { componentSku: true } } },
  });
  if (!output) return { success: false, error: `SKU not found: ${outputSkuId}`, warnings };
  if (output.bomComponents.length === 0) {
    return { success: false, error: `SKU ${output.sku} has no BOM; cannot produce it`, warnings };
  }

  const directBom: DirectBomLine[] = output.bomComponents.map((b) => ({
    componentSkuId: b.componentSkuId,
    componentType: b.componentSku.type,
    quantity: b.quantity,
  }));

  const moves = planProduction({ skuId: output.id, type: output.type }, qty, directBom);

  for (const move of moves) {
    if (move.reason === "PRODUCED") {
      if (!produce) continue;
      await addStock(db, move.skuId, move.delta, move.state);
      await logInventoryMovement(
        move.skuId, "PRODUCED", move.delta, undefined, move.state,
        opts.relatedResource, opts.relatedResourceType, opts.processName, opts.notes, opts.performedById, db
      );
    } else {
      const amount = -move.delta;
      const { shortBy } = await deductStockFifo(db, move.skuId, amount, move.state);
      if (shortBy > 0) {
        const comp = output.bomComponents.find((b) => b.componentSkuId === move.skuId);
        warnings.push(`${comp?.componentSku.sku ?? move.skuId} went negative by ${shortBy} in ${move.state}`);
      }
      await logInventoryMovement(
        move.skuId, consumeAction, amount, move.state, undefined,
        opts.relatedResource, opts.relatedResourceType, opts.processName, opts.notes, opts.performedById, db
      );
    }
  }

  return { success: true, warnings };
}

/**
 * Undo a previous production of `qty` of `outputSkuId`: remove the produced
 * output and add its consumed components back. The exact inverse of
 * applyProduction, used to correct a line that was submitted against the wrong
 * SKU (reverse the wrong one, then applyProduction the right one).
 */
export async function reverseProduction(
  outputSkuId: string,
  qty: number,
  opts: {
    relatedResource?: string;
    relatedResourceType?: string;
    processName?: string;
    performedById?: string;
    notes?: string;
  },
  client?: PrismaClientOrTx
): Promise<ApplyProductionResult> {
  const db = client || prisma;
  const warnings: string[] = [];
  if (qty <= 0) return { success: true, warnings };

  const output = await db.sku.findUnique({
    where: { id: outputSkuId },
    include: { bomComponents: { include: { componentSku: true } } },
  });
  if (!output) return { success: false, error: `SKU not found: ${outputSkuId}`, warnings };
  if (output.bomComponents.length === 0) {
    return { success: false, error: `SKU ${output.sku} has no BOM; cannot reverse it`, warnings };
  }

  const directBom: DirectBomLine[] = output.bomComponents.map((b) => ({
    componentSkuId: b.componentSkuId,
    componentType: b.componentSku.type,
    quantity: b.quantity,
  }));
  const moves = planProduction({ skuId: output.id, type: output.type }, qty, directBom);

  for (const move of moves) {
    if (move.reason === "PRODUCED") {
      // Original produced the output; reversal removes it.
      const { shortBy } = await deductStockFifo(db, move.skuId, move.delta, move.state);
      if (shortBy > 0) warnings.push(`${output.sku} went negative by ${shortBy} in ${move.state} while reversing`);
      await logInventoryMovement(
        move.skuId, "CONSUMED", move.delta, move.state, undefined,
        opts.relatedResource, opts.relatedResourceType, opts.processName, opts.notes ?? "Correction: reversed production", opts.performedById, db
      );
    } else {
      // Original consumed the component; reversal adds it back.
      const amount = -move.delta;
      await addStock(db, move.skuId, amount, move.state);
      await logInventoryMovement(
        move.skuId, "PRODUCED", amount, undefined, move.state,
        opts.relatedResource, opts.relatedResourceType, opts.processName, opts.notes ?? "Correction: restored component", opts.performedById, db
      );
    }
  }
  return { success: true, warnings };
}

// ============================================
// OPENING COUNTS / SPOT-CHECK (set absolute counts)
// ============================================

export interface CountPreviewItem {
  sku: string;
  name: string;
  type: SkuType;
  state: InventoryState;
  current: number;
  newQty: number;
  delta: number;
}

export interface OpeningCountResult {
  applied: boolean;
  items: CountPreviewItem[];
  unknownSkus: string[];
  warnings: string[];
}

/**
 * Set absolute on-hand counts from an opening-count / spot-check upload.
 * State is inferred from each SKU's type (RAW->RAW, ASSEMBLY->ASSEMBLED,
 * COMPLETED->COMPLETED). This SETS the count (not a delta) and records the
 * change as an ADJUSTED ledger entry — it is the day-zero seed and the weekly
 * spot-check correction described in PRODUCTION-PROCESS.md §6.
 *
 * Pass { dryRun: true } to get the preview (matched rows + what would change)
 * without writing anything.
 */
export async function applyOpeningCounts(
  rows: { sku: string; qty: number }[],
  performedById: string | undefined,
  opts: { dryRun: boolean }
): Promise<OpeningCountResult> {
  // Dedupe by SKU (a SKU maps to one state, so one count). Last value wins.
  const bySku = new Map<string, number>();
  const warnings: string[] = [];
  for (const r of rows) {
    if (bySku.has(r.sku)) {
      warnings.push(`${r.sku} listed more than once — using the last value (${r.qty})`);
    }
    bySku.set(r.sku, r.qty);
  }

  const items: CountPreviewItem[] = [];
  const unknownSkus: string[] = [];

  for (const [skuCode, qty] of bySku) {
    const sku = await prisma.sku.findFirst({
      where: { sku: { equals: skuCode, mode: "insensitive" } },
    });
    if (!sku) {
      unknownSkus.push(skuCode);
      continue;
    }
    const state = availableState(sku.type);
    const current = await getAvailableQuantity(sku.id, [state]);
    items.push({
      sku: sku.sku,
      name: sku.name,
      type: sku.type,
      state,
      current,
      newQty: qty,
      delta: qty - current,
    });
  }

  if (!opts.dryRun) {
    await prisma.$transaction(async (tx) => {
      for (const item of items) {
        if (item.delta === 0) continue;
        const skuRow = await tx.sku.findFirst({
          where: { sku: { equals: item.sku, mode: "insensitive" } },
        });
        if (!skuRow) continue;

        // SET the count: clear existing rows in this state, write one row.
        await tx.inventoryItem.deleteMany({ where: { skuId: skuRow.id, state: item.state } });
        if (item.newQty !== 0) {
          await tx.inventoryItem.create({
            data: { skuId: skuRow.id, quantity: item.newQty, state: item.state },
          });
        }

        await logInventoryMovement(
          skuRow.id, "ADJUSTED", item.newQty, undefined, item.state,
          undefined, "OPENING_COUNT", undefined,
          `Opening count: set ${item.state} to ${item.newQty} (was ${item.current})`,
          performedById, tx
        );
      }
    });
  }

  return { applied: !opts.dryRun, items, unknownSkus, warnings };
}

// ============================================
// AUTO-DEDUCTION (for Spreadsheet UI)
// ============================================

/**
 * Recursively explode a BOM to get all raw materials needed
 * Returns a map of SKU ID to total quantity needed
 */
async function explodeBOM(
  skuId: string,
  quantity: number,
  accumulated: Map<string, { sku: string; quantity: number }> = new Map()
): Promise<Map<string, { sku: string; quantity: number }>> {
  const sku = await prisma.sku.findUnique({
    where: { id: skuId },
    include: {
      bomComponents: {
        include: {
          componentSku: true,
        },
      },
    },
  });

  if (!sku) {
    return accumulated;
  }

  // If this is a RAW material, add it to the accumulated map
  if (sku.type === "RAW") {
    const existing = accumulated.get(skuId);
    if (existing) {
      existing.quantity += quantity;
    } else {
      accumulated.set(skuId, { sku: sku.sku, quantity });
    }
    return accumulated;
  }

  // If this is an ASSEMBLY or COMPLETED, recursively process its components
  if (sku.type === "ASSEMBLY" || sku.type === "COMPLETED") {
    for (const bomItem of sku.bomComponents) {
      const requiredQty = bomItem.quantity * quantity;
      await explodeBOM(bomItem.componentSkuId, requiredQty, accumulated);
    }
  }

  return accumulated;
}

/**
 * Automatically deduct BOM components when assembled/completed quantity increases
 * RECURSIVELY deducts all raw materials, even those in sub-assemblies
 * Called from inventory route when user edits quantity inline
 *
 * @deprecated This is the recursive "explode to raw" path that double-counts
 * against the single-level production engine (applyProduction) — see
 * test-production-engine.ts for the reproduction and PRODUCTION-PROCESS.md §1.
 * Inventory-grid edits should become manual ADJUSTED corrections, not BOM
 * deductions. Pending the path-consolidation decision; not yet removed.
 */
export async function autoDeductRawMaterials(
  assemblySkuId: string,
  quantityChange: number
): Promise<{ success: boolean; error?: string; deducted: { sku: string; quantity: number }[] }> {
  // Only deduct if quantity is increasing
  if (quantityChange <= 0) {
    return { success: true, deducted: [] };
  }

  // Get assembly info
  const assembly = await prisma.sku.findUnique({
    where: { id: assemblySkuId },
  });

  if (!assembly) {
    return { success: false, error: "SKU not found", deducted: [] };
  }

  if (assembly.type !== "ASSEMBLY" && assembly.type !== "COMPLETED") {
    return { success: false, error: `SKU ${assembly.sku} is type ${assembly.type}, not ASSEMBLY or COMPLETED`, deducted: [] };
  }

  // Recursively explode the BOM to get all raw materials
  const rawMaterialsMap = await explodeBOM(assemblySkuId, quantityChange);

  if (rawMaterialsMap.size === 0) {
    return { success: false, error: `SKU ${assembly.sku} has no BOM components configured`, deducted: [] };
  }

  const deducted: { sku: string; quantity: number }[] = [];
  const errors: string[] = [];

  // Deduct all raw materials
  for (const [skuId, { sku, quantity }] of rawMaterialsMap.entries()) {
    const result = await deductInventory(skuId, quantity, ["RAW"]);

    if (!result.success) {
      // Deduction failed - this should rarely happen since we allow negative inventory
      errors.push(`${sku}: ${result.error}`);
    } else {
      deducted.push({ sku, quantity });
    }
  }

  // If any deduction failed, return error
  if (errors.length > 0) {
    return {
      success: false,
      error: `Failed to deduct components: ${errors.join("; ")}`,
      deducted,
    };
  }

  return {
    success: true,
    deducted,
  };
}
