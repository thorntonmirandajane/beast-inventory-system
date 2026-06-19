import type { InventoryState, TimeEntryLine, WorkerTimeEntry } from "@prisma/client";
import prisma from "../db.server";
import { applyProduction } from "./inventory.server";
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
): Promise<{ success: boolean; error?: string; details?: string[]; warnings?: string[] }> {
  const details: string[] = [];
  const warnings: string[] = [];
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

        // Skip MISC tasks (no inventory impact)
        if (line.isMisc || !line.skuId) {
          details.push(`  SKIPPED: MISC task or no SKU`);
          console.log(`[Approve] Skipping MISC or no SKU line`);
          continue;
        }

        // Calculate base + rejected. A whole-line rejection (isRejected=true)
        // is treated as 100% rejected — the worker still attempted the work,
        // so the components were consumed and the rejected portion (the
        // whole batch) should land in the rejection tray for cherry-picking.
        const baseQuantity = line.adminAdjustedQuantity ?? line.quantityCompleted;
        const rejectedQuantity = line.isRejected
          ? baseQuantity
          : line.rejectionQuantity ?? 0;
        const finalQuantity = baseQuantity - rejectedQuantity;
        details.push(`  Quantity: ${finalQuantity} (base: ${baseQuantity}, rejected: ${rejectedQuantity})`);
        console.log(`[Approve] Final quantity: ${finalQuantity} (base: ${baseQuantity}, rejected: ${rejectedQuantity}, wholeLineRejected: ${line.isRejected})`);

        if (baseQuantity === 0) {
          details.push(`  SKIPPED: zero base quantity`);
          console.log(`[Approve] Skipping zero base quantity line`);
          continue;
        }

        // NOTE: inventory movement is BOM-driven — it depends only on the
        // line's output SKU and its BOM, NOT on the process name. So we do NOT
        // gate on a hardcoded process list anymore (that skipped any process the
        // user added, like "Tipping (100g Titanium)", and silently moved no
        // inventory). The process is just a label for efficiency.

        // Move inventory through the SINGLE production engine
        // (app/utils/production.ts → applyProduction). Accepted units consume
        // their immediate BOM children and produce the output; the output state
        // is derived from the output SKU's type, so STUD_TESTING correctly lands
        // broadheads in ASSEMBLED (not COMPLETED). No recursive BOM explosion —
        // that was the double-deduction bug.
        const accepted = await applyProduction(
          line.skuId,
          finalQuantity,
          {
            produce: true,
            relatedResource: entry.id,
            relatedResourceType: "TIME_ENTRY",
            processName: line.processName,
            performedById: entry.userId,
          },
          tx
        );
        if (!accepted.success) {
          // SKU has no BOM (e.g. a raw or mis-mapped output) or wasn't found —
          // skip this line rather than failing the whole approval.
          details.push(`  SKIPPED: ${accepted.error}`);
          console.warn(`[Approve] Skipping ${skuName}: ${accepted.error}`);
          continue;
        }
        details.push(`  Produced ${finalQuantity} ${skuName}, consumed its direct components`);
        for (const w of accepted.warnings) {
          details.push(`  WARNING: ${w}`);
          warnings.push(`${skuName}: ${w}`);
          console.warn(`[Approve] ${line.processName}: ${w}`);
        }

        // Rejected attempts physically consumed their children too, but yield
        // no good output — for now they are scrapped (DISPOSED) and surface in
        // the disposals list for add-back. PRODUCTION-PROCESS.md §4 (Phase 2)
        // replaces this with per-component recover-or-scrap.
        if (rejectedQuantity > 0) {
          const rejected = await applyProduction(
            line.skuId,
            rejectedQuantity,
            {
              produce: false,
              consumeAction: "DISPOSED",
              relatedResource: entry.id,
              relatedResourceType: "TIME_ENTRY",
              processName: line.processName,
              performedById: approvedById ?? entry.userId,
              notes:
                `Rejected during ${line.processName} of ${line.sku?.sku ?? "?"} (${rejectedQuantity} unit${rejectedQuantity !== 1 ? "s" : ""})` +
                (line.rejectionReason ? ` — ${line.rejectionReason}` : ""),
            },
            tx
          );
          if (!rejected.success) {
            details.push(`  FAILED (reject): ${rejected.error}`);
            throw new Error(rejected.error ?? "Reject teardown failed");
          }
          details.push(`  Scrapped ${rejectedQuantity} rejected unit(s) of ${skuName}`);
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

    return { success: true, details, warnings };
  } catch (error) {
    console.error("Error approving time entry:", error);
    details.push(`ERROR: ${error instanceof Error ? error.message : "Unknown error"}`);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
      details,
      warnings,
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
