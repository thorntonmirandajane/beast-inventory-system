// Server-only helpers for the worker "Submit Tasks" flow. They live here rather
// than in the route module because React Router strips only `loader`/`action`
// from the client bundle — a module-level helper touching Prisma would pull the
// server into the browser build.

import prisma from "../db.server";

/**
 * Today's DRAFT time entry for a worker, created if it doesn't exist yet.
 *
 * `clockInEventId` is unique, so the old check-then-create lost a race whenever
 * two submissions arrived together (a double-tap on a shared tablet): both saw
 * no entry, both tried to create one, and the loser threw a unique-constraint
 * error that reached the worker as "Something went wrong". On a collision we
 * now re-read the row the winner just made and carry on with it.
 */
export async function resolveTodaysEntry(userId: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const clockInEvent = await prisma.clockEvent.findFirst({
    where: { userId, type: "CLOCK_IN", timestamp: { gte: today, lt: tomorrow } },
    orderBy: { timestamp: "desc" },
  });

  if (clockInEvent) {
    const existing = await prisma.workerTimeEntry.findUnique({
      where: { clockInEventId: clockInEvent.id },
    });
    if (existing) return existing;
    try {
      return await prisma.workerTimeEntry.create({
        data: {
          userId,
          clockInEventId: clockInEvent.id,
          clockInTime: clockInEvent.timestamp,
          status: "DRAFT",
        },
      });
    } catch (err) {
      const won = await prisma.workerTimeEntry.findUnique({
        where: { clockInEventId: clockInEvent.id },
      });
      if (won) return won;
      throw err;
    }
  }

  // No clock-in today — tasks can still be submitted, so stand up a synthetic
  // clock-in to hang the entry off (clockInEventId is required).
  const syntheticClockIn = await prisma.clockEvent.create({
    data: {
      userId,
      type: "CLOCK_IN",
      timestamp: new Date(),
      notes: "Auto-created for task submission",
    },
  });
  return prisma.workerTimeEntry.create({
    data: {
      userId,
      clockInEventId: syntheticClockIn.id,
      clockInTime: syntheticClockIn.timestamp,
      status: "DRAFT",
    },
  });
}

/** Turn a thrown error into something a worker can act on. */
export function describeSubmitFailure(err: unknown): string {
  const code = (err as { code?: string })?.code;
  if (code === "P2002") {
    return "That submission was already recorded. Refresh your dashboard to check before submitting again.";
  }
  if (code === "P2003" || code === "P2025") {
    return "Something you picked (a SKU or process) has changed. Reload the page and add the tasks again.";
  }
  const message = err instanceof Error ? err.message : String(err);
  return `Your tasks couldn't be saved: ${message.split("\n")[0].slice(0, 160)}. Tell a manager if it keeps happening.`;
}

