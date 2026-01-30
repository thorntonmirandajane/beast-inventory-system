import type { InventoryState, TimeEntryLine, WorkerTimeEntry } from "@prisma/client";
import prisma from "../db.server";
import { addInventory, deductInventory } from "./inventory.server";
import { createAuditLog } from "./auth.server";

// Process-to-inventory transition mapping
// consumesRawFromBom: true means explode BOM and deduct all RAW materials (not intermediate states)
export const PROCESS_TRANSITIONS: Record<
  string,
  {
    consumes?: InventoryState;
    produces?: InventoryState;
    consumesRawFromBom?: boolean; // If true, explode BOM and deduct RAW materials instead of using consumes
    description: string;
  }
> = {
  TIPPING: {
    produces: "ASSEMBLED",
    consumesRawFromBom: true,
    description: "Tip raw ferrules to create assembled tips",
  },
  BLADING: {
    produces: "ASSEMBLED",
    consumesRawFromBom: true,
    description: "Add blades to assembled tips",
  },
  STUD_TESTING: {
    produces: "COMPLETED",
    consumesRawFromBom: true,
    description: "Test studs and complete production",
  },
  COMPLETE_PACKS: {
    produces: "COMPLETED",
    consumesRawFromBom: true,
    description: "Package items into completed products",
  },
};

// Recursively explode BOM to find all RAW materials needed
async function explodeBomForRawMaterials(
  skuId: string,
  quantity: number,
  rawMaterials: Map<string, { skuId: string; sku: string; needed: number }>,
  visited: Set<string> = new Set()
): Promise<void> {
  // Prevent infinite loops from circular references
  const visitKey = `${skuId}-${quantity}`;
  if (visited.has(skuId)) return;
  visited.add(skuId);

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

  if (!sku) return;

  for (const bomComp of sku.bomComponents) {
    const comp = bomComp.componentSku;
    const qtyNeeded = bomComp.quantity * quantity;

    if (comp.type === "RAW") {
      // Raw material - accumulate it
      const existing = rawMaterials.get(comp.id);
      if (existing) {
        existing.needed += qtyNeeded;
      } else {
        rawMaterials.set(comp.id, {
          skuId: comp.id,
          sku: comp.sku,
          needed: qtyNeeded,
        });
      }
    } else {
      // Assembly or other type - recurse into its BOM
      await explodeBomForRawMaterials(comp.id, qtyNeeded, rawMaterials, visited);
    }
  }
}

// Get process config with seconds per unit
export async function getProcessConfig(processName: string) {
  return prisma.processConfig.findUnique({
    where: { processName },
  });
}

// Get all active process configs
export async function getAllProcessConfigs() {
  return prisma.processConfig.findMany({
    where: { isActive: true },
    orderBy: { processName: "asc" },
  });
}

// Calculate efficiency for a time entry
export function calculateEfficiency(
  actualMinutes: number,
  expectedMinutes: number
): number {
  if (!actualMinutes || actualMinutes === 0) return 0;
  return (expectedMinutes / actualMinutes) * 100;
}

// Calculate expected time from lines
export function calculateExpectedMinutes(
  lines: Array<{ quantityCompleted: number; secondsPerUnit: number }>
): number {
  const totalSeconds = lines.reduce(
    (sum, line) => sum + line.quantityCompleted * line.secondsPerUnit,
    0
  );
  return totalSeconds / 60;
}

// Get or create a draft time entry for the current shift
export async function getOrCreateDraftTimeEntry(
  userId: string,
  clockInEventId: string,
  clockInTime: Date
) {
  // Check for existing draft
  const existing = await prisma.workerTimeEntry.findUnique({
    where: { clockInEventId },
    include: { lines: true },
  });

  if (existing) {
    return existing;
  }

  // Create new draft
  return prisma.workerTimeEntry.create({
    data: {
      userId,
      clockInEventId,
      clockInTime,
      status: "DRAFT",
    },
    include: { lines: true },
  });
}

// Submit time entry for approval
export async function submitTimeEntry(
  timeEntryId: string,
  clockOutEventId: string,
  clockOutTime: Date,
  breakMinutes: number,
  lines: Array<{
    processName: string;
    skuId?: string | null;
    quantityCompleted: number;
    secondsPerUnit: number;
    workerTaskId?: string | null;
    notes?: string | null;
  }>
) {
  // Calculate actual minutes worked
  const entry = await prisma.workerTimeEntry.findUnique({
    where: { id: timeEntryId },
  });

  if (!entry) {
    throw new Error("Time entry not found");
  }

  const clockInMs = entry.clockInTime.getTime();
  const clockOutMs = clockOutTime.getTime();
  const totalMinutes = (clockOutMs - clockInMs) / 1000 / 60;
  const actualMinutes = Math.round(totalMinutes - breakMinutes);

  // Calculate expected minutes from lines
  const expectedMinutes = calculateExpectedMinutes(lines);

  // Calculate efficiency
  const efficiency = calculateEfficiency(actualMinutes, expectedMinutes);

  // Update entry and create lines
  return prisma.$transaction(async (tx) => {
    // Delete existing lines
    await tx.timeEntryLine.deleteMany({
      where: { timeEntryId },
    });

    // Create new lines
    for (const line of lines) {
      await tx.timeEntryLine.create({
        data: {
          timeEntryId,
          processName: line.processName,
          skuId: line.skuId,
          quantityCompleted: line.quantityCompleted,
          secondsPerUnit: line.secondsPerUnit,
          expectedSeconds: line.quantityCompleted * line.secondsPerUnit,
          workerTaskId: line.workerTaskId,
          notes: line.notes,
        },
      });
    }

    // Update the entry
    return tx.workerTimeEntry.update({
      where: { id: timeEntryId },
      data: {
        clockOutEventId,
        clockOutTime,
        breakMinutes,
        actualMinutes,
        expectedMinutes,
        efficiency,
        status: "PENDING",
      },
      include: {
        lines: true,
        user: true,
      },
    });
  });
}

// Approve a time entry and adjust inventory
export async function approveTimeEntry(
  timeEntryId: string,
  approvedById?: string
): Promise<{ success: boolean; error?: string; details?: string[] }> {
  const details: string[] = [];
  const entry = await prisma.workerTimeEntry.findUnique({
    where: { id: timeEntryId },
    include: {
      lines: {
        include: { sku: true, workerTask: true },
      },
      user: true,
    },
  });

  if (!entry) {
    return { success: false, error: "Time entry not found" };
  }

  if (entry.status !== "PENDING") {
    return { success: false, error: "Time entry is not pending approval" };
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Process inventory changes for each line
      for (const line of entry.lines) {
        const skuName = line.sku?.sku || line.skuId || "unknown";
        details.push(`Processing: ${line.processName} for ${skuName}`);
        console.log(`[Approve] Processing line: ${line.processName}, SKU: ${line.skuId}, isRejected: ${line.isRejected}, isMisc: ${line.isMisc}`);

        // Skip rejected lines for inventory updates
        if (line.isRejected) {
          details.push(`  SKIPPED: line is rejected`);
          console.log(`[Approve] Skipping rejected line`);
          continue;
        }

        // Skip MISC tasks (no inventory impact)
        if (line.isMisc || !line.skuId) {
          details.push(`  SKIPPED: MISC task or no SKU`);
          console.log(`[Approve] Skipping MISC or no SKU line`);
          continue;
        }

        // Calculate final quantity: (admin adjusted OR submitted) minus rejected
        const baseQuantity = line.adminAdjustedQuantity ?? line.quantityCompleted;
        const rejectedQuantity = line.rejectionQuantity ?? 0;
        const finalQuantity = baseQuantity - rejectedQuantity;
        details.push(`  Quantity: ${finalQuantity} (base: ${baseQuantity}, rejected: ${rejectedQuantity})`);
        console.log(`[Approve] Final quantity: ${finalQuantity} (base: ${baseQuantity}, rejected: ${rejectedQuantity})`);

        if (finalQuantity === 0) {
          details.push(`  SKIPPED: zero quantity`);
          console.log(`[Approve] Skipping zero quantity line`);
          continue; // Skip if fully rejected/adjusted to zero
        }

        const transition = PROCESS_TRANSITIONS[line.processName];
        if (!transition) {
          details.push(`  SKIPPED: No transition found for process "${line.processName}"`);
          console.warn(`[Approve] No transition found for process: ${line.processName}`);
          continue;
        }

        details.push(`  Transition: produces ${transition.produces}, consumesRawFromBom: ${transition.consumesRawFromBom}`);
        console.log(`[Approve] Transition found: consumes ${transition.consumes}, produces ${transition.produces}, consumesRawFromBom: ${transition.consumesRawFromBom}`);

        // Deduct inventory - either from BOM raw materials or from specific state
        if (transition.consumesRawFromBom) {
          // Explode BOM and deduct all RAW materials
          console.log(`[Approve] Exploding BOM for SKU ${line.skuId} to find raw materials`);
          const rawMaterials = new Map<string, { skuId: string; sku: string; needed: number }>();
          await explodeBomForRawMaterials(line.skuId, finalQuantity, rawMaterials);

          details.push(`  BOM explosion found ${rawMaterials.size} raw materials`);
          console.log(`[Approve] Found ${rawMaterials.size} raw materials to deduct`);

          for (const [rawSkuId, rawMaterial] of rawMaterials) {
            details.push(`    Deducting ${rawMaterial.needed} of ${rawMaterial.sku}`);
            console.log(`[Approve] Deducting ${rawMaterial.needed} units of RAW ${rawMaterial.sku} (${rawSkuId})`);
            const deductResult = await deductInventory(
              rawSkuId,
              rawMaterial.needed,
              ["RAW"], // Always deduct from RAW state for raw materials
              entry.id,
              "TIME_ENTRY",
              line.processName,
              entry.userId,
              tx // Pass transaction client
            );

            if (!deductResult.success) {
              details.push(`    FAILED: ${deductResult.error}`);
              console.error(`[Approve] Deduction of raw material ${rawMaterial.sku} failed: ${deductResult.error}`);
              throw new Error(`Failed to deduct raw material ${rawMaterial.sku}: ${deductResult.error}`);
            }
            console.log(`[Approve] Deduction of ${rawMaterial.sku} successful`);
          }
        } else if (transition.consumes) {
          // Legacy behavior: deduct from specific inventory state
          details.push(`  Deducting ${finalQuantity} ${transition.consumes} from ${skuName}`);
          console.log(`[Approve] Deducting ${finalQuantity} units of ${transition.consumes} from SKU ${line.skuId}`);
          const deductResult = await deductInventory(
            line.skuId,
            finalQuantity,
            [transition.consumes],
            entry.id,
            "TIME_ENTRY",
            line.processName,
            entry.userId,
            tx // Pass transaction client
          );

          if (!deductResult.success) {
            details.push(`  FAILED: ${deductResult.error}`);
            console.error(`[Approve] Deduction failed: ${deductResult.error}`);
            throw new Error(`Failed to deduct inventory: ${deductResult.error}`);
          }
          console.log(`[Approve] Deduction successful`);
        }

        // Add produced inventory
        if (transition.produces) {
          details.push(`  Adding ${finalQuantity} ${transition.produces} to ${skuName}`);
          console.log(`[Approve] Adding ${finalQuantity} units of ${transition.produces} to SKU ${line.skuId}`);
          try {
            await addInventory(
              line.skuId,
              finalQuantity,
              transition.produces,
              undefined,
              undefined,
              entry.id,
              "TIME_ENTRY",
              line.processName,
              entry.userId,
              tx // Pass transaction client
            );
            details.push(`  SUCCESS: Added ${finalQuantity} ${transition.produces}`);
            console.log(`[Approve] Addition successful`);
          } catch (addError) {
            console.error(`[Approve] ERROR in addInventory:`, addError);
            details.push(`  ERROR adding inventory: ${addError instanceof Error ? addError.message : String(addError)}`);
            throw addError; // Re-throw to fail the transaction
          }
        }

        // Mark linked task as completed if any
        if (line.workerTaskId) {
          await tx.workerTask.update({
            where: { id: line.workerTaskId },
            data: {
              status: "COMPLETED",
              completedAt: new Date(),
            },
          });
        }
      }

      // Update the time entry
      await tx.workerTimeEntry.update({
        where: { id: timeEntryId },
        data: {
          status: "APPROVED",
          approvedById: approvedById || entry.userId,
          approvedAt: new Date(),
        },
      });

      // Create audit log if approvedById is provided
      if (approvedById) {
        await createAuditLog(
          approvedById,
          "APPROVE_TIME_ENTRY",
          "WorkerTimeEntry",
          timeEntryId,
          {
            workerId: entry.userId,
            workerName: `${entry.user.firstName} ${entry.user.lastName}`,
            efficiency: entry.efficiency,
            linesCount: entry.lines.length,
            adjustedLines: entry.lines.filter(l => l.adminAdjustedQuantity).length,
            rejectedLines: entry.lines.filter(l => l.isRejected).length,
          }
        );
      }
    });

    return { success: true, details };
  } catch (error) {
    console.error("Error approving time entry:", error);
    details.push(`ERROR: ${error instanceof Error ? error.message : "Unknown error"}`);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
      details,
    };
  }
}

// Reject a time entry
export async function rejectTimeEntry(
  timeEntryId: string,
  rejectedById: string,
  reason: string,
  photo: string | null = null
) {
  const entry = await prisma.workerTimeEntry.findUnique({
    where: { id: timeEntryId },
    include: { user: true },
  });

  if (!entry) {
    throw new Error("Time entry not found");
  }

  if (entry.status !== "PENDING") {
    throw new Error("Time entry is not pending approval");
  }

  const updatedEntry = await prisma.workerTimeEntry.update({
    where: { id: timeEntryId },
    data: {
      status: "REJECTED",
      rejectionReason: reason,
      rejectionPhoto: photo,
      approvedById: rejectedById,
      approvedAt: new Date(),
    },
    include: {
      lines: true,
      user: true,
    },
  });

  await createAuditLog(
    rejectedById,
    "REJECT_TIME_ENTRY",
    "WorkerTimeEntry",
    timeEntryId,
    {
      workerId: entry.userId,
      workerName: `${entry.user.firstName} ${entry.user.lastName}`,
      reason,
    }
  );

  return updatedEntry;
}

// Get worker efficiency stats
export async function getWorkerEfficiencyStats(
  userId: string,
  days: number = 30
) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const entries = await prisma.workerTimeEntry.findMany({
    where: {
      userId,
      status: "APPROVED",
      clockInTime: { gte: since },
    },
    include: {
      lines: true,
    },
    orderBy: { clockInTime: "desc" },
  });

  // Calculate overall stats
  let totalActualMinutes = 0;
  let totalExpectedMinutes = 0;
  const byProcess: Record<
    string,
    { totalQuantity: number; totalExpectedMinutes: number }
  > = {};

  for (const entry of entries) {
    if (entry.actualMinutes) totalActualMinutes += entry.actualMinutes;
    if (entry.expectedMinutes) totalExpectedMinutes += entry.expectedMinutes;

    for (const line of entry.lines) {
      if (!byProcess[line.processName]) {
        byProcess[line.processName] = {
          totalQuantity: 0,
          totalExpectedMinutes: 0,
        };
      }
      byProcess[line.processName].totalQuantity += line.quantityCompleted;
      byProcess[line.processName].totalExpectedMinutes +=
        line.expectedSeconds / 60;
    }
  }

  const overallEfficiency = calculateEfficiency(
    totalActualMinutes,
    totalExpectedMinutes
  );

  return {
    entries,
    totalEntries: entries.length,
    totalActualMinutes,
    totalExpectedMinutes,
    overallEfficiency,
    byProcess,
  };
}

// Get pending tasks for a worker
export async function getWorkerTasks(userId: string, includeBacklog = true) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const whereClause: any = {
    userId,
    status: { in: ["PENDING", "IN_PROGRESS"] },
  };

  if (!includeBacklog) {
    whereClause.OR = [
      { assignmentType: "DAILY", dueDate: { gte: today, lt: tomorrow } },
    ];
  }

  return prisma.workerTask.findMany({
    where: whereClause,
    include: {
      sku: true,
      assignedBy: {
        select: { firstName: true, lastName: true },
      },
    },
    orderBy: [
      { assignmentType: "asc" }, // DAILY first
      { priority: "desc" },
      { createdAt: "asc" },
    ],
  });
}

// Create a worker task
export async function createWorkerTask(data: {
  userId: string;
  processName: string;
  skuId?: string | null;
  targetQuantity?: number | null;
  priority?: number;
  assignmentType: "DAILY" | "BACKLOG";
  assignedById: string;
  dueDate?: Date | null;
  notes?: string | null;
}) {
  return prisma.workerTask.create({
    data: {
      userId: data.userId,
      processName: data.processName,
      skuId: data.skuId,
      targetQuantity: data.targetQuantity,
      priority: data.priority ?? 0,
      assignmentType: data.assignmentType,
      assignedById: data.assignedById,
      dueDate: data.dueDate,
      notes: data.notes,
    },
    include: {
      user: true,
      sku: true,
      assignedBy: {
        select: { firstName: true, lastName: true },
      },
    },
  });
}
