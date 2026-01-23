import { ClockEvent } from "@prisma/client";

export interface WeeklyHours {
  weekStart: Date;
  weekEnd: Date;
  hours: number;
}

export interface OvertimeCalculation {
  regularHours: number;
  overtimeHours: number;
  regularPay: number;
  overtimePay: number;
  totalPay: number;
  weeks: WeeklyHours[];
}

/**
 * Calculate weekly hours from clock events
 * Week defined as Monday 00:00 - Sunday 23:59
 */
export function calculateWeeklyHours(events: ClockEvent[]): WeeklyHours[] {
  const weeks = new Map<string, { start: Date; end: Date; totalMs: number }>();

  // Sort events by timestamp
  const sorted = events.slice().sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  // Pair clock in/out events
  for (let i = 0; i < sorted.length; i++) {
    const event = sorted[i];

    if (event.type === "CLOCK_IN") {
      // Find matching clock out
      const clockOut = sorted.slice(i + 1).find(e => e.type === "CLOCK_OUT");

      if (!clockOut) continue;

      const weekKey = getWeekKey(event.timestamp);
      const { weekStart, weekEnd } = getWeekBoundaries(event.timestamp);

      if (!weeks.has(weekKey)) {
        weeks.set(weekKey, {
          start: weekStart,
          end: weekEnd,
          totalMs: 0,
        });
      }

      const week = weeks.get(weekKey)!;
      const durationMs = clockOut.timestamp.getTime() - event.timestamp.getTime();
      week.totalMs += durationMs;
    }
  }

  // Convert to WeeklyHours array
  return Array.from(weeks.values())
    .map(w => ({
      weekStart: w.start,
      weekEnd: w.end,
      hours: w.totalMs / (1000 * 60 * 60),
    }))
    .sort((a, b) => a.weekStart.getTime() - b.weekStart.getTime());
}

/**
 * Calculate overtime pay based on weekly hours
 * Regular time: First 40 hours at base rate
 * Overtime: Hours over 40 at 1.5x base rate
 */
export function calculateOvertimePay(
  weeklyHours: WeeklyHours[],
  payRate: number
): OvertimeCalculation {
  let totalRegularHours = 0;
  let totalOvertimeHours = 0;

  for (const week of weeklyHours) {
    if (week.hours <= 40) {
      totalRegularHours += week.hours;
    } else {
      totalRegularHours += 40;
      totalOvertimeHours += (week.hours - 40);
    }
  }

  const regularPay = totalRegularHours * payRate;
  const overtimePay = totalOvertimeHours * payRate * 1.5;
  const totalPay = regularPay + overtimePay;

  return {
    regularHours: totalRegularHours,
    overtimeHours: totalOvertimeHours,
    regularPay,
    overtimePay,
    totalPay,
    weeks: weeklyHours,
  };
}

/**
 * Get week key for grouping (format: "2026-W04")
 * Week starts Monday
 */
function getWeekKey(date: Date): string {
  const { weekStart } = getWeekBoundaries(date);
  const year = weekStart.getFullYear();
  const weekNum = getWeekNumber(weekStart);
  return `${year}-W${String(weekNum).padStart(2, "0")}`;
}

/**
 * Get Monday-Sunday boundaries for the week containing the given date
 */
function getWeekBoundaries(date: Date): { weekStart: Date; weekEnd: Date } {
  const dayOfWeek = date.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Convert to Monday-based

  const weekStart = new Date(date);
  weekStart.setDate(date.getDate() - daysFromMonday);
  weekStart.setHours(0, 0, 0, 0);

  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);

  return { weekStart, weekEnd };
}

/**
 * Get ISO week number (Monday as first day of week)
 */
function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7; // Sunday=7, Monday=1
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
