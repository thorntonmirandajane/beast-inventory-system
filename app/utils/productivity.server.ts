import type { InventoryState, TimeEntryLine, WorkerTimeEntry } from "@prisma/client";
import prisma from "../db.server";
import { addInventory, deductInventory } from "./inventory.server";
import { createAuditLog } from "./auth.server";

// Process-to-inventory transition mapping
export const PROCESS_TRANSITIONS: Record<
  string,
  {
    consumes?: InventoryState;
    produces?: InventoryState;
    description: string;
  }
> = {
  TIPPING: {
    consumes: "RAW",
    produces: "ASSEMBLED",
    description: "Tip raw ferrules to create assembled tips",
  },
  BLADING: {
    consumes: "ASSEMBLED",
    produces: "ASSEMBLED",
    description: "Add blades to assembled tips (state unchanged)",
  },
  STUD_TESTING: {
    // No inventory change - validation/QC step
    description: "Test studs for quality (no inventory change)",
  },
  COMPLETE_PACKS: {
    consumes: "ASSEMBLED",
    produces: "COMPLETED",
    description: "Package assembled items into completed products",
  },
};

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
  approvedById: string
) {
  const entry = await prisma.workerTimeEntry.findUnique({
    where: { id: timeEntryId },
    include: {
      lines: {
        include: { sku: true },
      },
      user: true,
    },
  });

  if (!entry) {
    throw new Error("Time entry not found");
  }

  if (entry.status !== "PENDING") {
    throw new Error("Time entry is not pending approval");
  }

  return prisma.$transaction(async (tx) => {
    // Process inventory changes for each line
    for (const line of entry.lines) {
      if (!line.skuId) continue;

      const transition = PROCESS_TRANSITIONS[line.processName];
      if (!transition) continue;

      // Deduct consumed inventory
      if (transition.consumes) {
        await deductInventory(line.skuId, line.quantityCompleted, [transition.consumes]);
      }

      // Add produced inventory
      if (transition.produces) {
        await addInventory(line.skuId, line.quantityCompleted, transition.produces);
      }
    }

    // Mark associated tasks as completed
    const taskIds = entry.lines
      .filter((l) => l.workerTaskId)
      .map((l) => l.workerTaskId!);

    if (taskIds.length > 0) {
      await tx.workerTask.updateMany({
        where: { id: { in: taskIds } },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
        },
      });
    }

    // Update the time entry
    const updatedEntry = await tx.workerTimeEntry.update({
      where: { id: timeEntryId },
      data: {
        status: "APPROVED",
        approvedById,
        approvedAt: new Date(),
      },
      include: {
        lines: true,
        user: true,
      },
    });

    // Create audit log
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
      }
    );

    return updatedEntry;
  });
}

// Reject a time entry
export async function rejectTimeEntry(
  timeEntryId: string,
  rejectedById: string,
  reason: string
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
