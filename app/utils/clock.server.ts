import prisma from "../db.server";

/**
 * True if, as of `at`, the user's most recent clock-in/out event is a CLOCK_IN
 * — i.e. they are already on the clock at that moment. Use this to block a
 * duplicate/overlapping clock-in while still allowing legitimate split shifts
 * (clock in → out → in again when NOT already clocked in).
 */
export async function isClockedInAt(userId: string, at: Date): Promise<boolean> {
  const prev = await prisma.clockEvent.findFirst({
    where: { userId, type: { in: ["CLOCK_IN", "CLOCK_OUT"] }, timestamp: { lte: at } },
    orderBy: { timestamp: "desc" },
    select: { type: true },
  });
  return prev?.type === "CLOCK_IN";
}

/** True if the user has any clock-in/out event on the calendar day of `at`. */
export async function hasClockActivityOnDay(userId: string, at: Date): Promise<boolean> {
  const dayStart = new Date(at);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(at);
  dayEnd.setHours(23, 59, 59, 999);
  const ev = await prisma.clockEvent.findFirst({
    where: { userId, type: { in: ["CLOCK_IN", "CLOCK_OUT"] }, timestamp: { gte: dayStart, lte: dayEnd } },
    select: { id: true },
  });
  return !!ev;
}
