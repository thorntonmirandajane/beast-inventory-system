import prisma from "../db.server";
import type { InventoryState, SkuType, Prisma } from "@prisma/client";

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
