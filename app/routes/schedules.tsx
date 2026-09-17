import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation, Link } from "react-router";
import { requireUser, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { useState } from "react";
import { parseShorthand, toShorthand } from "../utils/schedule-hours";
import { buildShifts } from "../utils/overtime.server";
import { useFetcher } from "react-router";
import { TimeRangePicker, BottomSheetTimePicker } from "../components/TimePicker";

const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ymd = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
};
const addDays = (d: Date, n: number) => {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  r.setHours(12, 0, 0, 0);
  return r;
};
const mondayOf = (d: Date) => {
  const r = new Date(d);
  const dow = r.getDay(); // 0 Sun..6 Sat
  const diff = dow === 0 ? -6 : 1 - dow;
  r.setDate(r.getDate() + diff);
  r.setHours(12, 0, 0, 0);
  return r;
};
const dateAtNoon = (ymdStr: string) => new Date(`${ymdStr}T12:00:00`);
const weekLabel = (monday: Date) => {
  const sun = addDays(monday, 6);
  const mo = monday.toLocaleDateString("en-US", { month: "short" });
  const so = sun.toLocaleDateString("en-US", { month: "short" });
  return mo === so ? `${mo} ${monday.getDate()}–${sun.getDate()}` : `${mo} ${monday.getDate()}–${so} ${sun.getDate()}`;
};

const DAYS = [
  { id: 0, name: "SUNDAY", short: "SUN" },
  { id: 1, name: "MONDAY", short: "MON" },
  { id: 2, name: "TUESDAY", short: "TUE" },
  { id: 3, name: "WEDNESDAY", short: "WED" },
  { id: 4, name: "THURSDAY", short: "THU" },
  { id: 5, name: "FRIDAY", short: "FRI" },
  { id: 6, name: "SATURDAY", short: "SAT" },
];


export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const url = new URL(request.url);
  const isWorkerView = user.role === "WORKER";
  const view = url.searchParams.get("view") || (isWorkerView ? "month" : "week");

  // Selected week (Monday-start).
  const wsParam = url.searchParams.get("weekStart");
  const monday = wsParam && /^\d{4}-\d{2}-\d{2}$/.test(wsParam) ? mondayOf(dateAtNoon(wsParam)) : mondayOf(new Date());
  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const rangeStart = new Date(monday); rangeStart.setHours(0, 0, 0, 0);
  const rangeEnd = addDays(monday, 6); rangeEnd.setHours(23, 59, 59, 999);

  // Workers (admin: all active; worker: self). Kept for the calendar too.
  const workersRaw = await prisma.user.findMany({
    where: isWorkerView ? { id: user.id } : { isActive: true },
    include: { schedules: { where: { isActive: true }, orderBy: [{ scheduleDate: "asc" }, { dayOfWeek: "asc" }] } },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  const workerIds = workersRaw.map((w) => w.id);
  const workers = workersRaw.map((w) => ({
    ...w,
    recurringSchedules: w.schedules.filter((s) => s.scheduleType === "RECURRING"),
    dateSchedules: w.schedules.filter((s) => s.scheduleType === "SPECIFIC_DATE"),
    weeklyHours: 0,
  }));

  // Saved date-specific rows for the visible week.
  const weekRows = await prisma.workerSchedule.findMany({
    where: { userId: { in: workerIds }, scheduleType: "SPECIFIC_DATE", isActive: true, scheduleDate: { gte: rangeStart, lte: rangeEnd } },
    select: { userId: true, scheduleDate: true, startTime: true, endTime: true },
  });
  const savedByKey = new Map<string, { start: string; end: string }>();
  for (const r of weekRows) if (r.scheduleDate) savedByKey.set(`${r.userId}|${ymd(r.scheduleDate)}`, { start: r.startTime, end: r.endTime });

  // Recurring pattern (deactivated) — used only to pre-fill unsaved cells.
  const patternRows = await prisma.workerSchedule.findMany({
    where: { userId: { in: workerIds }, scheduleType: "RECURRING" },
    select: { userId: true, dayOfWeek: true, startTime: true, endTime: true },
  });
  const patternByKey = new Map<string, { start: string; end: string }>();
  for (const r of patternRows) if (r.dayOfWeek != null) patternByKey.set(`${r.userId}|${r.dayOfWeek}`, { start: r.startTime, end: r.endTime });

  const gridWorkers = workersRaw.map((w) => ({
    id: w.id,
    name: `${w.firstName} ${w.lastName}`,
    cells: weekDates.map((d) => {
      const dateY = ymd(d);
      const saved = savedByKey.get(`${w.id}|${dateY}`);
      if (saved) return { date: dateY, start: saved.start, end: saved.end, value: toShorthand(saved.start, saved.end), saved: true };
      const pat = patternByKey.get(`${w.id}|${d.getDay()}`);
      if (pat) return { date: dateY, start: pat.start, end: pat.end, value: toShorthand(pat.start, pat.end), saved: false };
      return { date: dateY, start: "", end: "", value: "", saved: false };
    }),
  }));

  // Approved time off overlapping the visible week -> per-cell conflict label.
  const timeOff = await prisma.timeOffRequest.findMany({
    where: { userId: { in: workerIds }, status: "APPROVED", startDate: { lte: rangeEnd }, endDate: { gte: rangeStart } },
    select: { userId: true, startDate: true, endDate: true },
  });
  // Time-off dates are stored at UTC midnight — read the calendar day in UTC so
  // it isn't shifted back a day by the (Mountain) server timezone.
  const dOnly = (dt: Date) => dt.toISOString().slice(0, 10);
  const fmtShort = (dt: Date) => dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const timeOffByCell: Record<string, string> = {};
  for (const t of timeOff) {
    const s = dOnly(t.startDate);
    const e = dOnly(t.endDate);
    const label = s === e ? fmtShort(t.startDate) : `${fmtShort(t.startDate)}–${fmtShort(t.endDate)}`;
    for (const d of weekDates) {
      const dY = ymd(d);
      if (dY >= s && dY <= e) timeOffByCell[`${t.userId}|${dY}`] = label;
    }
  }

  // Actual hours worked this week (from clock events) per worker, for compare.
  const weekEvents = await prisma.clockEvent.findMany({
    where: { userId: { in: workerIds }, type: { in: ["CLOCK_IN", "CLOCK_OUT"] }, timestamp: { gte: rangeStart, lte: rangeEnd } },
    orderBy: { timestamp: "asc" },
  });
  const actualByWorker: Record<string, number> = {};
  for (const w of workersRaw) {
    const shifts = buildShifts(weekEvents.filter((e) => e.userId === w.id));
    actualByWorker[w.id] = Math.round(shifts.reduce((t, s) => t + s.hours, 0) * 100) / 100;
  }

  const days = weekDates.map((d) => ({ ymd: ymd(d), label: DAY_ABBR[d.getDay()], dom: d.getDate() }));
  const weekTabs = [-1, 0, 1, 2, 3].map((off) => {
    const m = addDays(monday, off * 7);
    return { weekStart: ymd(m), label: weekLabel(m), active: off === 0 };
  });

  // Calendar view still shows upcoming date-specific schedules.
  const today = new Date();
  const sixtyDaysLater = new Date(today);
  sixtyDaysLater.setDate(today.getDate() + 60);
  const upcomingDateSchedules = await prisma.workerSchedule.findMany({
    where: {
      scheduleType: "SPECIFIC_DATE",
      scheduleDate: { gte: today, lte: sixtyDaysLater },
      isActive: true,
      userId: isWorkerView ? user.id : undefined,
    },
    include: { user: { select: { firstName: true, lastName: true } } },
    orderBy: { scheduleDate: "asc" },
  });

  // Schedule requests.
  let scheduleRequests: any[] = [];
  let myRequest: any = null;
  let pendingRequestCount = 0;
  if (isWorkerView) {
    myRequest = await prisma.scheduleRequest.findFirst({
      where: { userId: user.id },
      orderBy: { submittedAt: "desc" },
      select: { id: true, status: true, days: true, note: true, submittedAt: true, reviewedAt: true },
    });
  } else {
    const reqs = await prisma.scheduleRequest.findMany({ where: { status: "PENDING" }, orderBy: { submittedAt: "asc" } });
    pendingRequestCount = reqs.length;
    const ids = [...new Set(reqs.map((r) => r.userId))];
    const us = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true } }) : [];
    const nameById = new Map(us.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));
    scheduleRequests = reqs.map((r) => ({ id: r.id, userId: r.userId, workerName: nameById.get(r.userId) ?? "Unknown", status: r.status, days: r.days, note: r.note, submittedAt: r.submittedAt }));
  }

  // Worker mobile Month/Week day-card data.
  let myMonth: any = null;
  let myWeek: any = null;
  if (isWorkerView) {
    const now = new Date();
    const monthParam = url.searchParams.get("month");
    const [my, mm] = monthParam && /^\d{4}-\d{2}$/.test(monthParam) ? monthParam.split("-").map(Number) : [now.getFullYear(), now.getMonth() + 1];
    const monthIdx = mm - 1;
    const first = new Date(my, monthIdx, 1); first.setHours(12, 0, 0, 0);
    const gridStart = new Date(first); gridStart.setDate(1 - first.getDay()); gridStart.setHours(12, 0, 0, 0);
    const monthCells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
    const wkSun = new Date(now); wkSun.setDate(now.getDate() - now.getDay()); wkSun.setHours(12, 0, 0, 0);
    const weekCells = Array.from({ length: 7 }, (_, i) => addDays(wkSun, i));

    const all = [...monthCells, ...weekCells];
    const lo = new Date(Math.min(...all.map((d) => d.getTime()))); lo.setHours(0, 0, 0, 0);
    const hi = new Date(Math.max(...all.map((d) => d.getTime()))); hi.setHours(23, 59, 59, 999);
    const appr = await prisma.workerSchedule.findMany({
      where: { userId: user.id, scheduleType: "SPECIFIC_DATE", isActive: true, scheduleDate: { gte: lo, lte: hi } },
      select: { scheduleDate: true, startTime: true, endTime: true },
    });
    const apprBy = new Map<string, { start: string; end: string }>();
    for (const r of appr) if (r.scheduleDate) apprBy.set(ymd(r.scheduleDate), { start: r.startTime, end: r.endTime });
    const pendBy = new Map<string, { start: string; end: string }>();
    if (myRequest) { try { for (const c of (JSON.parse(myRequest.days).cells ?? [])) if (c.start && c.end) pendBy.set(c.date, { start: c.start, end: c.end }); } catch { /* older format */ } }

    const card = (d: Date, dowLabel = false) => {
      const dY = ymd(d);
      const pend = pendBy.get(dY);
      const app = apprBy.get(dY);
      const src = pend ?? app ?? null;
      return {
        date: dY, dom: d.getDate(), inMonth: d.getMonth() === monthIdx,
        start: src?.start ?? "", end: src?.end ?? "",
        hours: src ? toShorthand(src.start, src.end) : "",
        status: pend ? "pending" : app ? "approved" : "none",
        ...(dowLabel ? { dow: DAY_ABBR[d.getDay()] } : {}),
      };
    };
    const ym = (dt: Date) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
    myMonth = {
      label: first.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
      prevMonth: ym(new Date(my, monthIdx - 1, 1)),
      nextMonth: ym(new Date(my, monthIdx + 1, 1)),
      weeks: Array.from({ length: 6 }, (_, r) => monthCells.slice(r * 7, r * 7 + 7).map((d) => card(d))),
    };
    const ws = weekCells[0], we = weekCells[6];
    myWeek = {
      label: `${ws.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${we.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
      days: weekCells.map((d) => card(d, true)),
    };
  }

  return {
    user, isWorkerView, view,
    workers, upcomingDateSchedules,
    gridWorkers, days, weekStartYmd: ymd(monday), weekTitle: weekLabel(monday),
    weekTabs, prevWeek: ymd(addDays(monday, -7)), nextWeek: ymd(addDays(monday, 7)),
    timeOffByCell, actualByWorker,
    scheduleRequests, myRequest, pendingRequestCount,
    myMonth, myWeek,
  };
};


export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // Worker submits their weekly grid for approval (does NOT go live).
  if (intent === "submit-schedule-request") {
    const weekStart = String(formData.get("weekStart") || "");
    let cells: { date: string; value: string }[] = [];
    try { cells = JSON.parse(String(formData.get("cells") || "[]")); } catch { cells = []; }
    const days = JSON.stringify({ weekStart, cells });
    const existing = await prisma.scheduleRequest.findFirst({ where: { userId: user.id, status: "PENDING" } });
    if (existing) await prisma.scheduleRequest.update({ where: { id: existing.id }, data: { days, submittedAt: new Date() } });
    else await prisma.scheduleRequest.create({ data: { userId: user.id, days, status: "PENDING" } });
    await createAuditLog(user.id, "SUBMIT_SCHEDULE_REQUEST", "ScheduleRequest", user.id, {});
    return { success: true, message: "Schedule request submitted for approval." };
  }

  // Worker taps a day in the Month/Week view -> upsert that date into their
  // pending request (does NOT go live until approved). Off/blank removes it.
  if (intent === "set-my-day") {
    const date = String(formData.get("date") || "");
    const start = String(formData.get("start") || "");
    const end = String(formData.get("end") || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "Bad date." };
    const req = await prisma.scheduleRequest.findFirst({ where: { userId: user.id, status: "PENDING" } });
    let cells: any[] = [];
    if (req) { try { cells = JSON.parse(req.days).cells ?? []; } catch { cells = []; } }
    cells = cells.filter((c: any) => c.date !== date);
    const on = !!(start && end && end > start);
    if (on) cells.push({ date, start, end, value: toShorthand(start, end) });
    cells.sort((a: any, b: any) => a.date.localeCompare(b.date));
    if (cells.length === 0) {
      if (req) await prisma.scheduleRequest.delete({ where: { id: req.id } });
      return { success: true, message: "Updated." };
    }
    const days = JSON.stringify({ cells });
    if (req) await prisma.scheduleRequest.update({ where: { id: req.id }, data: { days, status: "PENDING", submittedAt: new Date() } });
    else await prisma.scheduleRequest.create({ data: { userId: user.id, days, status: "PENDING" } });
    return { success: true, message: on ? "Requested — pending approval." : "Cleared." };
  }

  // Everything below is admin-only.
  if (user.role !== "ADMIN") throw new Response("UNAUTHORIZED", { status: 403 });

  // Save one grid cell (on blur/tab). Blank/off clears the day; invalid rejected.
  if (intent === "set-schedule-cell") {
    const workerId = String(formData.get("workerId") || "");
    const date = String(formData.get("date") || "");
    if (!workerId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "Bad cell." };
    const input = formData.has("value")
      ? { value: String(formData.get("value") || "") }
      : { start: String(formData.get("start") || ""), end: String(formData.get("end") || "") };
    const res = await writeCell(workerId, date, input);
    if (res.error) return { cellError: true, workerId, date, message: res.error };
    return { cellSaved: true, workerId, date };
  }

  // Commit the whole visible week (one-click save of a pre-filled week).
  if (intent === "commit-week") {
    let cells: { workerId: string; date: string; start?: string; end?: string }[] = [];
    try { cells = JSON.parse(String(formData.get("cells") || "[]")); } catch { cells = []; }
    let saved = 0, errors = 0;
    await prisma.$transaction(async (tx) => {
      for (const c of cells) {
        const res = await writeCell(c.workerId, c.date, { start: c.start ?? "", end: c.end ?? "" }, tx);
        if (res.error) errors++; else saved++;
      }
    }, { timeout: 120000, maxWait: 15000 });
    await createAuditLog(user.id, "COMMIT_SCHEDULE_WEEK", "WorkerSchedule", "week", { saved, errors });
    return { success: true, message: `Saved ${saved} day(s)${errors ? `, ${errors} invalid skipped` : ""}.` };
  }

  if (intent === "approve-schedule-request") {
    const requestId = formData.get("requestId") as string;
    const req = await prisma.scheduleRequest.findUnique({ where: { id: requestId } });
    if (!req || req.status !== "PENDING") return { error: "Request not found or already handled." };
    let cells: { date: string; value: string }[] = [];
    const editedRaw = formData.get("cells") as string | null;
    try { cells = editedRaw ? JSON.parse(editedRaw) : (JSON.parse(req.days).cells ?? []); }
    catch { try { cells = JSON.parse(req.days).cells ?? []; } catch { cells = []; } }
    await prisma.$transaction(async (tx) => {
      for (const c of cells) await writeCell(req.userId, c.date, { start: (c as any).start, end: (c as any).end, value: c.value }, tx);
      let meta: any = {}; try { meta = JSON.parse(req.days || "{}"); } catch { meta = {}; }
      await tx.scheduleRequest.update({ where: { id: requestId }, data: { status: "APPROVED", reviewedAt: new Date(), reviewedById: user.id, days: JSON.stringify({ ...meta, cells }) } });
    }, { timeout: 120000, maxWait: 15000 });
    await createAuditLog(user.id, "APPROVE_SCHEDULE_REQUEST", "ScheduleRequest", requestId, {});
    return { success: true, message: "Request approved — schedule updated." };
  }

  if (intent === "deny-schedule-request") {
    const requestId = formData.get("requestId") as string;
    const note = ((formData.get("note") as string) || "").trim() || null;
    const req = await prisma.scheduleRequest.findUnique({ where: { id: requestId } });
    if (!req || req.status !== "PENDING") return { error: "Request not found or already handled." };
    await prisma.scheduleRequest.update({ where: { id: requestId }, data: { status: "DENIED", note, reviewedAt: new Date(), reviewedById: user.id } });
    await createAuditLog(user.id, "DENY_SCHEDULE_REQUEST", "ScheduleRequest", requestId, {});
    return { success: true, message: "Request denied." };
  }

  return { error: "INVALID ACTION" };
};

// Write one (worker, date) cell. Accepts explicit start/end (from the time
// picker) or a shorthand `value` (worker request / older paths). Both empty =>
// day off (clears the row). Invalid -> reported.
async function writeCell(
  workerId: string,
  date: string,
  input: { start?: string; end?: string; value?: string },
  tx: any = prisma
): Promise<{ error?: string }> {
  let start = input.start;
  let end = input.end;
  let off = false;
  if (start == null && end == null && input.value != null) {
    const parsed = parseShorthand(input.value);
    if (parsed.error) return { error: parsed.error };
    if (parsed.off) off = true;
    else { start = parsed.start; end = parsed.end; }
  } else {
    if (!start && !end) off = true;
    else if (!start || !end) return { error: "incomplete" };
    else if (end <= start) return { error: "order" };
  }
  const scheduleDate = dateAtNoon(date);
  const dayStart = new Date(scheduleDate); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(scheduleDate); dayEnd.setHours(23, 59, 59, 999);
  // Clear any existing date-specific row(s) for that day first. (dayOfWeek is
  // NULL for SPECIFIC_DATE, and Postgres treats NULLs as distinct in the unique
  // index, so upsert can't reliably match — delete-then-create keeps exactly one.)
  await tx.workerSchedule.deleteMany({ where: { userId: workerId, scheduleType: "SPECIFIC_DATE", scheduleDate: { gte: dayStart, lte: dayEnd } } });
  if (off) return {};
  await tx.workerSchedule.create({
    data: { userId: workerId, dayOfWeek: null, scheduleDate, scheduleType: "SPECIFIC_DATE", startTime: start as string, endTime: end as string, isActive: true },
  });
  return {};
}

// Calendar helper functions
function isSameDay(date1: Date, date2: Date): boolean {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate()
  );
}

interface CalendarDay {
  date: Date | null;
  schedules: any[];
  recurringSchedules: any[];
}

function generateCalendarMonth(year: number, month: number, dateSchedules: any[], workers: any[]): CalendarDay[][] {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const daysInMonth = lastDay.getDate();
  const startDayOfWeek = firstDay.getDay();

  const weeks: CalendarDay[][] = [];
  let currentWeek: CalendarDay[] = [];

  // Padding for first week
  for (let i = 0; i < startDayOfWeek; i++) {
    currentWeek.push({ date: null, schedules: [], recurringSchedules: [] });
  }

  // Days of month
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month, day);
    const dayOfWeek = date.getDay();

    // Find specific date schedules for this date
    const daySchedules = dateSchedules.filter((s) => {
      if (s.scheduleDate) {
        const scheduleDate = new Date(s.scheduleDate);
        return isSameDay(scheduleDate, date);
      }
      return false;
    });

    // Find recurring schedules for this day of week
    const recurringForDay: any[] = [];
    workers.forEach((worker) => {
      const recurring = worker.recurringSchedules?.filter((s: any) => s.dayOfWeek === dayOfWeek && s.isActive);
      if (recurring && recurring.length > 0) {
        recurring.forEach((s: any) => {
          recurringForDay.push({
            ...s,
            user: { firstName: worker.firstName, lastName: worker.lastName },
          });
        });
      }
    });

    currentWeek.push({ date, schedules: daySchedules, recurringSchedules: recurringForDay });

    // End of week
    if (currentWeek.length === 7) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
  }

  // Padding for last week
  while (currentWeek.length < 7 && currentWeek.length > 0) {
    currentWeek.push({ date: null, schedules: [], recurringSchedules: [] });
  }
  if (currentWeek.length > 0) {
    weeks.push(currentWeek);
  }

  return weeks;
}

function CalendarView({ workers, upcomingDateSchedules, user }: { workers: any[]; upcomingDateSchedules: any[]; user: any }) {
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDay, setSelectedDay] = useState<CalendarDay | null>(null);
  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();

  const weeks = generateCalendarMonth(year, month, upcomingDateSchedules, workers);
  const today = new Date();

  const goToPreviousMonth = () => {
    setCurrentMonth(new Date(year, month - 1));
  };

  const goToNextMonth = () => {
    setCurrentMonth(new Date(year, month + 1));
  };

  const isToday = (date: Date | null) => {
    if (!date) return false;
    return isSameDay(date, today);
  };

  const hasSchedules = (day: CalendarDay) => {
    return day.schedules.length > 0 || day.recurringSchedules.length > 0;
  };

  return (
    <>
      <div className="calendar-container">
        {/* Header */}
        <div className="calendar-header">
          <button onClick={goToPreviousMonth} className="calendar-nav-btn" aria-label="Previous month">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h3 className="calendar-title">
            {currentMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
          </h3>
          <button onClick={goToNextMonth} className="calendar-nav-btn" aria-label="Next month">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>

        {/* Day headers */}
        <div className="calendar-weekdays">
          {DAYS.map((day) => (
            <div key={day.id} className="calendar-weekday">
              <span className="hidden sm:inline">{day.short}</span>
              <span className="sm:hidden">{day.short.substring(0, 1)}</span>
            </div>
          ))}
        </div>

        {/* Calendar grid */}
        <div className="calendar-grid">
          {weeks.map((week, wIdx) => (
            <div key={wIdx} className="calendar-week">
              {week.map((day, dIdx) => {
                const hasSched = hasSchedules(day);
                const isTodayDate = isToday(day.date);

                return (
                  <div
                    key={dIdx}
                    onClick={() => day.date && hasSched ? setSelectedDay(day) : null}
                    className={`calendar-day ${!day.date ? 'calendar-day-empty' : ''} ${
                      isTodayDate ? 'calendar-day-today' : ''
                    } ${hasSched ? 'calendar-day-has-schedule' : ''}`}
                  >
                    {day.date && (
                      <>
                        <div className={`calendar-day-number ${isTodayDate ? 'calendar-day-number-today' : ''}`}>
                          {day.date.getDate()}
                        </div>
                        {/* Show dot indicators for schedules */}
                        {hasSched && (
                          <div className="calendar-day-indicators">
                            {day.schedules.length > 0 && (
                              <div className="calendar-dot calendar-dot-specific"></div>
                            )}
                            {day.recurringSchedules.length > 0 && day.schedules.length === 0 && (
                              <div className="calendar-dot calendar-dot-recurring"></div>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* Legend */}
        <div className="calendar-legend">
          <div className="calendar-legend-item">
            <div className="calendar-dot calendar-dot-specific"></div>
            <span>Specific Date</span>
          </div>
          <div className="calendar-legend-item">
            <div className="calendar-dot calendar-dot-recurring"></div>
            <span>Recurring</span>
          </div>
        </div>
      </div>

      {/* Day Details Modal */}
      {selectedDay && selectedDay.date && (
        <div className="calendar-modal-overlay" onClick={() => setSelectedDay(null)}>
          <div className="calendar-modal" onClick={(e) => e.stopPropagation()}>
            <div className="calendar-modal-header">
              <h4 className="calendar-modal-title">
                {selectedDay.date.toLocaleDateString("en-US", {
                  weekday: "long",
                  month: "long",
                  day: "numeric"
                })}
              </h4>
              <button onClick={() => setSelectedDay(null)} className="calendar-modal-close">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="calendar-modal-content">
              {selectedDay.schedules.length > 0 && (
                <div className="calendar-modal-section">
                  <h5 className="calendar-modal-section-title">Specific Date Schedules</h5>
                  {selectedDay.schedules.map((schedule, idx) => (
                    <div key={idx} className="calendar-modal-schedule">
                      <div className="calendar-modal-schedule-name">
                        {schedule.user.firstName} {schedule.user.lastName}
                      </div>
                      <div className="calendar-modal-schedule-time">
                        {schedule.startTime} - {schedule.endTime}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {selectedDay.recurringSchedules.length > 0 && (
                <div className="calendar-modal-section">
                  <h5 className="calendar-modal-section-title">Recurring Schedules</h5>
                  {selectedDay.recurringSchedules.map((schedule, idx) => (
                    <div key={idx} className="calendar-modal-schedule calendar-modal-schedule-recurring">
                      <div className="calendar-modal-schedule-name">
                        {schedule.user.firstName} {schedule.user.lastName}
                      </div>
                      <div className="calendar-modal-schedule-time">
                        {schedule.startTime} - {schedule.endTime}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <style>{`
        .calendar-container {
          background: white;
          border-radius: 12px;
          padding: 16px;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
        }

        .calendar-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
          padding: 0 8px;
        }

        .calendar-title {
          font-size: 18px;
          font-weight: 600;
          color: #1f2937;
        }

        .calendar-nav-btn {
          padding: 8px;
          border-radius: 8px;
          background: transparent;
          border: none;
          color: #4b5563;
          cursor: pointer;
          transition: background-color 0.2s;
        }

        .calendar-nav-btn:hover {
          background: #f3f4f6;
        }

        .calendar-weekdays {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          gap: 4px;
          margin-bottom: 8px;
        }

        .calendar-weekday {
          text-align: center;
          font-size: 11px;
          font-weight: 600;
          color: #6b7280;
          padding: 8px 0;
        }

        .calendar-grid {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .calendar-week {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          gap: 4px;
        }

        .calendar-day {
          aspect-ratio: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          border-radius: 8px;
          background: white;
          position: relative;
          cursor: default;
          transition: all 0.2s;
        }

        .calendar-day-empty {
          background: transparent;
        }

        .calendar-day-has-schedule {
          cursor: pointer;
        }

        .calendar-day-has-schedule:hover {
          background: #f9fafb;
          transform: scale(1.05);
        }

        .calendar-day-today {
          background: #dbeafe;
        }

        .calendar-day-number {
          font-size: 14px;
          font-weight: 500;
          color: #374151;
          margin-bottom: 2px;
        }

        .calendar-day-number-today {
          background: #3b82f6;
          color: white;
          width: 28px;
          height: 28px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 600;
        }

        .calendar-day-indicators {
          display: flex;
          gap: 4px;
          margin-top: 4px;
        }

        .calendar-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
        }

        .calendar-dot-specific {
          background: #3b82f6;
        }

        .calendar-dot-recurring {
          background: #10b981;
        }

        .calendar-legend {
          display: flex;
          gap: 16px;
          margin-top: 16px;
          padding-top: 16px;
          border-top: 1px solid #e5e7eb;
          justify-content: center;
        }

        .calendar-legend-item {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          color: #6b7280;
        }

        .calendar-modal-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.4);
          display: flex;
          align-items: flex-end;
          justify-content: center;
          z-index: 50;
          padding: 16px;
        }

        .calendar-modal {
          background: white;
          border-radius: 16px 16px 0 0;
          width: 100%;
          max-width: 500px;
          max-height: 80vh;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          animation: slideUp 0.3s ease-out;
        }

        @keyframes slideUp {
          from {
            transform: translateY(100%);
          }
          to {
            transform: translateY(0);
          }
        }

        .calendar-modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 20px;
          border-bottom: 1px solid #e5e7eb;
        }

        .calendar-modal-title {
          font-size: 18px;
          font-weight: 600;
          color: #1f2937;
        }

        .calendar-modal-close {
          padding: 4px;
          border-radius: 8px;
          background: transparent;
          border: none;
          color: #6b7280;
          cursor: pointer;
        }

        .calendar-modal-content {
          padding: 20px;
          overflow-y: auto;
        }

        .calendar-modal-section {
          margin-bottom: 20px;
        }

        .calendar-modal-section:last-child {
          margin-bottom: 0;
        }

        .calendar-modal-section-title {
          font-size: 14px;
          font-weight: 600;
          color: #6b7280;
          margin-bottom: 12px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .calendar-modal-schedule {
          padding: 12px;
          background: #f3f4f6;
          border-radius: 8px;
          margin-bottom: 8px;
        }

        .calendar-modal-schedule:last-child {
          margin-bottom: 0;
        }

        .calendar-modal-schedule-recurring {
          background: #d1fae5;
        }

        .calendar-modal-schedule-name {
          font-size: 15px;
          font-weight: 600;
          color: #1f2937;
          margin-bottom: 4px;
        }

        .calendar-modal-schedule-time {
          font-size: 13px;
          color: #6b7280;
          font-weight: 500;
        }

        @media (min-width: 640px) {
          .calendar-container {
            padding: 24px;
          }

          .calendar-title {
            font-size: 20px;
          }

          .calendar-weekday {
            font-size: 12px;
          }

          .calendar-day-number {
            font-size: 16px;
          }

          .calendar-dot {
            width: 7px;
            height: 7px;
          }

          .calendar-modal {
            border-radius: 16px;
            max-height: 70vh;
          }

          .calendar-modal-overlay {
            align-items: center;
          }
        }
      `}</style>
    </>
  );
}

const fmtHrs = (n: number) => String(Math.round(n * 100) / 100);
const cellHours = (v: string) => {
  const p = parseShorthand(v);
  return p.error ? 0 : p.hours;
};
const hhmmHours = (start: string, end: string) => {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return Math.max(0, eh + em / 60 - (sh + sm / 60));
};

export default function Schedules() {
  const {
    user, isWorkerView, view, gridWorkers, days, weekStartYmd, weekTitle, weekTabs,
    prevWeek, nextWeek, workers, upcomingDateSchedules, timeOffByCell, actualByWorker,
    scheduleRequests, myRequest, pendingRequestCount, myMonth, myWeek,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const tabCls = (v: string) =>
    `px-4 py-2 font-medium border-b-2 transition-colors ${view === v ? "border-blue-500 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"}`;

  if (isWorkerView) {
    return (
      <Layout user={user}>
        <div className="page-header">
          <h1 className="page-title">My Schedule</h1>
          <p className="page-subtitle">Tap a day to request your hours. Amber = pending, green = approved.</p>
        </div>
        {myRequest?.status === "DENIED" && (
          <div className="alert alert-error mb-4">Your last request was denied{myRequest.note ? `: ${myRequest.note}` : "."}</div>
        )}
        <WorkerSchedule view={view === "week" ? "week" : "month"} myMonth={myMonth} myWeek={myWeek} />
      </Layout>
    );
  }

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Worker Schedules</h1>
        <p className="page-subtitle">Weekly hours grid — click a day to set start/end. Blank = day off.</p>
      </div>

      {actionData && "error" in actionData && actionData.error && <div className="alert alert-error mb-6">{actionData.error}</div>}
      {actionData && "success" in actionData && actionData.success && <div className="alert alert-success mb-6">{actionData.message}</div>}

      <div className="flex gap-2 mb-6 border-b border-gray-200">
        <Link to={`/schedules?view=week&weekStart=${weekStartYmd}`} className={tabCls("week")}>Weekly Grid</Link>
        <Link to="/schedules?view=calendar" className={tabCls("calendar")}>Calendar View</Link>
        <Link to="/schedules?view=requests" className={tabCls("requests")}>
          Requests
          {pendingRequestCount > 0 && <span className="ml-2 inline-block bg-red-100 text-red-700 text-xs font-semibold px-2 py-0.5 rounded-full">{pendingRequestCount}</span>}
        </Link>
      </div>

      {view === "week" && (
        <>
          <WeekNav weekTitle={weekTitle} prevWeek={prevWeek} nextWeek={nextWeek} weekTabs={weekTabs} />
          <WeeklyGrid gridWorkers={gridWorkers} days={days} timeOffByCell={timeOffByCell} actualByWorker={actualByWorker} weekStartYmd={weekStartYmd} />
        </>
      )}

      {view === "calendar" && (
        <CalendarView workers={workers} upcomingDateSchedules={upcomingDateSchedules} user={user} />
      )}

      {view === "requests" && (
        <RequestsList requests={scheduleRequests} isSubmitting={isSubmitting} />
      )}
    </Layout>
  );
}

// ---- Worker mobile Month/Week view ----
function WorkerSchedule({ view, myMonth, myWeek }: any) {
  const fetcher = useFetcher();
  const [open, setOpen] = useState<{ date: string; start: string; end: string; label: string } | null>(null);

  const submit = (date: string, start: string, end: string) => {
    fetcher.submit({ intent: "set-my-day", date, start, end }, { method: "post" });
  };
  const onTap = (c: any) => {
    const d = dateAtNoon(c.date);
    const label = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    setOpen({ date: c.date, start: c.start || "", end: c.end || "", label });
  };

  // Inline grid so the global "@media(max-width:768px){.grid{grid-cols-1}}" hack
  // (used to stack QC cards) can't collapse the 7-column calendar on phones.
  const g7 = (gap: number): React.CSSProperties => ({ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap });
  const Dot = ({ status }: { status: string }) => (
    <span
      style={{
        position: "absolute", top: 4, right: 4, width: 9, height: 9, borderRadius: 9999,
        background: status === "approved" ? "#10b981" : status === "pending" ? "#f59e0b" : "transparent",
        border: status === "none" ? "1.5px solid #d1d5db" : "none",
      }}
    />
  );
  const Card = ({ c, muted }: { c: any; muted?: boolean }) => (
    <button
      type="button"
      onClick={() => onTap(c)}
      style={{ position: "relative", aspectRatio: "1 / 1", minWidth: 0 }}
      className={`rounded-xl border flex flex-col items-center justify-center p-1 transition-colors ${muted ? "opacity-40" : ""} ${c.status === "approved" ? "border-green-300 bg-green-50" : c.status === "pending" ? "border-amber-300 bg-amber-50" : "border-gray-200 bg-white"} hover:border-blue-400`}
    >
      <Dot status={c.status} />
      <span className="text-sm font-semibold text-gray-800 leading-none">{c.dom}</span>
      {c.hours && <span className="text-[9px] sm:text-[10px] text-gray-600 mt-1 leading-none">{c.hours}</span>}
    </button>
  );

  return (
    <>
      <div className="flex gap-2 mb-4 border-b border-gray-200">
        <Link to="/schedules?view=month" className={`px-4 py-2 font-medium border-b-2 ${view === "month" ? "border-blue-500 text-blue-600" : "border-transparent text-gray-500"}`}>Month</Link>
        <Link to="/schedules?view=week" className={`px-4 py-2 font-medium border-b-2 ${view === "week" ? "border-blue-500 text-blue-600" : "border-transparent text-gray-500"}`}>Week</Link>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-gray-600 mb-3">
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full" style={{ background: "#10b981" }} /> Approved</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full" style={{ background: "#f59e0b" }} /> Pending</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full" style={{ border: "1.5px solid #d1d5db" }} /> Not set</span>
      </div>

      <div className="card">
        <div className="card-body p-3 sm:p-4">
          {view === "month" ? (
            <>
              <div className="flex items-center justify-between mb-3">
                <Link to={`/schedules?view=month&month=${myMonth.prevMonth}`} className="btn btn-secondary btn-sm">←</Link>
                <span className="font-semibold">{myMonth.label}</span>
                <Link to={`/schedules?view=month&month=${myMonth.nextMonth}`} className="btn btn-secondary btn-sm">→</Link>
              </div>
              <div className="mb-1 text-center text-[11px] font-semibold text-gray-500" style={g7(4)}>
                {DAY_ABBR.map((d) => <div key={d}>{d}</div>)}
              </div>
              <div className="space-y-1">
                {myMonth.weeks.map((wk: any[], wi: number) => (
                  <div key={wi} style={g7(4)}>
                    {wk.map((c) => <Card key={c.date} c={c} muted={!c.inMonth} />)}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="text-center font-semibold mb-3">{myWeek.label}</div>
              <div style={g7(6)}>
                {myWeek.days.map((c: any) => (
                  <div key={c.date} className="flex flex-col items-center" style={{ minWidth: 0 }}>
                    <div className="text-[11px] font-semibold text-gray-500 mb-1">{c.dow}</div>
                    <div style={{ width: "100%" }}><Card c={c} /></div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {open && (
        <BottomSheetTimePicker
          start={open.start}
          end={open.end}
          title={open.label}
          onDone={(s, e) => submit(open.date, s, e)}
          onClear={() => submit(open.date, "", "")}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

function WeekNav({ weekTitle, prevWeek, nextWeek, weekTabs }: any) {
  return (
    <div className="flex items-center gap-2 mb-4 flex-wrap">
      <Link to={`/schedules?view=week&weekStart=${prevWeek}`} className="btn btn-secondary btn-sm">←</Link>
      <span className="font-semibold px-2 min-w-[130px] text-center">{weekTitle}</span>
      <Link to={`/schedules?view=week&weekStart=${nextWeek}`} className="btn btn-secondary btn-sm">→</Link>
      <div className="flex gap-1 ml-2 flex-wrap">
        {weekTabs.map((t: any) => (
          <Link key={t.weekStart} to={`/schedules?view=week&weekStart=${t.weekStart}`} className={`px-2 py-1 rounded text-xs ${t.active ? "bg-blue-100 text-blue-700 font-semibold" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{t.label}</Link>
        ))}
      </div>
    </div>
  );
}

function WeeklyGrid({ gridWorkers, days, timeOffByCell, actualByWorker, weekStartYmd }: any) {
  const key = (w: string, d: string) => `${w}|${d}`;
  const [cells, setCells] = useState<Record<string, { start: string; end: string }>>(() => {
    const o: Record<string, { start: string; end: string }> = {};
    for (const w of gridWorkers) for (const c of w.cells) o[key(w.id, c.date)] = { start: c.start || "", end: c.end || "" };
    return o;
  });
  const [savedKeys, setSavedKeys] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const w of gridWorkers) for (const c of w.cells) if (c.saved) s.add(key(w.id, c.date));
    return s;
  });
  const [open, setOpen] = useState<{ k: string; wid: string; date: string; anchor: { left: number; bottom: number; width: number } } | null>(null);
  const [showActual, setShowActual] = useState(false);

  const save = (wid: string, date: string, start: string, end: string) => {
    const fd = new FormData();
    fd.append("intent", "set-schedule-cell");
    fd.append("workerId", wid);
    fd.append("date", date);
    fd.append("start", start);
    fd.append("end", end);
    fetch(window.location.pathname + window.location.search, { method: "POST", body: fd }).catch(() => {});
  };
  const setCell = (wid: string, date: string, start: string, end: string) => {
    const k = key(wid, date);
    setCells((s) => ({ ...s, [k]: { start, end } }));
    setSavedKeys((s) => new Set(s).add(k));
    save(wid, date, start, end);
  };

  const cellHrs = (k: string) => { const c = cells[k]; return c ? hhmmHours(c.start, c.end) : 0; };
  const dayTotal = (di: number) => gridWorkers.reduce((t: number, w: any) => t + cellHrs(key(w.id, days[di].ymd)), 0);
  const rowTotal = (w: any) => days.reduce((t: number, d: any) => t + cellHrs(key(w.id, d.ymd)), 0);
  const grand = days.reduce((t: number, _d: any, di: number) => t + dayTotal(di), 0);
  const commitCells = gridWorkers.flatMap((w: any) => w.cells.map((c: any) => { const cur = cells[key(w.id, c.date)] || { start: "", end: "" }; return { workerId: w.id, date: c.date, start: cur.start, end: cur.end }; }));
  const th = "px-3 py-3 whitespace-nowrap";

  return (
    <div className="card mx-1 md:mx-4">
      <div className="card-body p-4 md:p-6">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
          <Form method="post">
            <input type="hidden" name="intent" value="commit-week" />
            <input type="hidden" name="cells" value={JSON.stringify(commitCells)} />
            <button className="btn btn-secondary btn-sm" type="submit">Save week (commit pre-filled)</button>
          </Form>
          <div className="flex items-center gap-4">
            <label className="text-sm flex items-center gap-1.5"><input type="checkbox" checked={showActual} onChange={(e) => setShowActual(e.target.checked)} /> Show actual</label>
            <a href={`/schedules/print?weekStart=${weekStartYmd}`} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">Print / Export</a>
          </div>
        </div>
        <p className="text-xs text-gray-500 mb-4">Click a day to set start/end times. Amber = pre-filled, not yet saved. Red ⚠ = conflicts with approved time off.</p>

        <div className="overflow-x-auto pb-2">
          <table className="text-sm" style={{ borderSpacing: "8px 4px", borderCollapse: "separate" }}>
            <thead>
              <tr className="text-gray-500">
                <th className={`${th} text-left sticky left-0 bg-white z-10`}>Worker</th>
                {days.map((d: any) => <th key={d.ymd} className={`${th} text-center`}>{d.label} {d.dom}</th>)}
                <th className={`${th} text-right`}>Total</th>
                {showActual && <><th className={`${th} text-right`}>Actual</th><th className={`${th} text-right`}>Diff</th></>}
              </tr>
            </thead>
            <tbody>
              {gridWorkers.map((w: any) => {
                const sched = rowTotal(w);
                const actual = actualByWorker[w.id] ?? 0;
                const diff = Math.round((actual - sched) * 100) / 100;
                return (
                  <tr key={w.id}>
                    <td className="px-3 py-2 whitespace-nowrap font-medium sticky left-0 bg-white z-10">{w.name}</td>
                    {days.map((d: any) => {
                      const k = key(w.id, d.ymd);
                      const c = cells[k] || { start: "", end: "" };
                      const has = !!(c.start && c.end);
                      const label = has ? toShorthand(c.start, c.end) : "—";
                      const prefilled = !savedKeys.has(k) && has;
                      const conflict = has && !!timeOffByCell[k];
                      return (
                        <td key={d.ymd} className="px-1 py-1 text-center">
                          <button
                            type="button"
                            onClick={(ev) => {
                              const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                              setOpen(open?.k === k ? null : { k, wid: w.id, date: d.ymd, anchor: { left: r.left, bottom: r.bottom, width: r.width } });
                            }}
                            title={conflict ? `Conflicts with approved time off (${timeOffByCell[k]})` : prefilled ? "Pre-filled — not saved yet" : ""}
                            className={`w-20 h-11 rounded border text-sm transition-colors ${conflict ? "border-red-500 bg-red-50 text-red-700" : prefilled ? "border-amber-300 bg-amber-50 text-gray-500" : has ? "border-gray-300 hover:border-blue-400" : "border-dashed border-gray-300 text-gray-400 hover:border-blue-400"}`}
                          >
                            {conflict && <span className="mr-0.5">⚠</span>}{label}
                          </button>
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-right font-medium">{fmtHrs(sched)}</td>
                    {showActual && (
                      <>
                        <td className="px-3 py-2 text-right">{fmtHrs(actual)}</td>
                        <td className={`px-3 py-2 text-right font-medium ${Math.abs(diff) >= 2 ? (diff > 0 ? "text-green-700" : "text-red-600") : "text-gray-500"}`}>{diff > 0 ? "+" : ""}{fmtHrs(diff)}</td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="font-semibold bg-gray-50">
                <td className="px-3 py-3 sticky left-0 bg-gray-50 z-10">Daily total</td>
                {days.map((d: any, di: number) => <td key={d.ymd} className="px-3 py-3 text-center">{fmtHrs(dayTotal(di))}</td>)}
                <td className="px-3 py-3 text-right">{fmtHrs(grand)}</td>
                {showActual && <><td className="px-3 py-3 text-right">{fmtHrs(gridWorkers.reduce((t: number, w: any) => t + (actualByWorker[w.id] ?? 0), 0))}</td><td /></>}
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {open && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setOpen(null)} />
          <TimeRangePicker
            start={cells[open.k]?.start || ""}
            end={cells[open.k]?.end || ""}
            anchor={open.anchor}
            onDone={(s, e) => setCell(open.wid, open.date, s, e)}
            onClear={() => setCell(open.wid, open.date, "", "")}
            onClose={() => setOpen(null)}
          />
        </>
      )}
    </div>
  );
}

function RequestsList({ requests, isSubmitting }: any) {
  if (!requests.length) {
    return <div className="card"><div className="card-body text-center text-gray-500 py-8">No pending schedule requests.</div></div>;
  }
  return <div className="space-y-4">{requests.map((r: any) => <RequestReviewCard key={r.id} req={r} isSubmitting={isSubmitting} />)}</div>;
}

function RequestReviewCard({ req, isSubmitting }: any) {
  let meta: any = {};
  try { meta = JSON.parse(req.days); } catch { meta = {}; }
  const initCells: any[] = Array.isArray(meta.cells) ? meta.cells : [];
  const [cells, setCells] = useState(() => initCells.map((c) => ({ date: c.date, start: c.start ?? "", end: c.end ?? "", value: c.value ?? toShorthand(c.start, c.end), edited: false })));
  const [denying, setDenying] = useState(false);
  const total = cells.reduce((t, c) => t + cellHours(c.value), 0);
  const dow = (y: string) => { const d = dateAtNoon(y); return `${DAY_ABBR[d.getDay()]} ${d.getDate()}`; };
  // Edited cells re-parse the shorthand; untouched keep the worker's exact times.
  const postCells = cells.map((c) => {
    if (!c.edited) return { date: c.date, start: c.start, end: c.end, value: c.value };
    const p = parseShorthand(c.value);
    if (p.off) return { date: c.date, value: "" };
    if (p.error) return { date: c.date, value: c.value };
    return { date: c.date, start: p.start, end: p.end, value: c.value };
  });

  return (
    <div className="card">
      <div className="card-header flex justify-between items-center">
        <h2 className="card-title">{req.workerName}</h2>
        <span className="text-xs text-gray-500">Submitted {new Date(req.submittedAt).toLocaleDateString()}{meta.weekStart ? ` · week of ${meta.weekStart}` : ""}</span>
      </div>
      <div className="card-body">
        {cells.length === 0 ? (
          <p className="text-sm text-gray-500">This request was submitted in an older format and can't be shown here — ask the worker to resubmit.</p>
        ) : (
          <>
            <p className="text-sm text-gray-600 mb-2">Adjust hours if needed, then approve. Blank = day off.</p>
            <div className="overflow-x-auto">
              <table className="text-sm">
                <thead><tr>{cells.map((c, i) => <th key={i} className="p-2 text-center whitespace-nowrap">{dow(c.date)}</th>)}<th className="p-2">Total</th></tr></thead>
                <tbody><tr>
                  {cells.map((c, i) => {
                    const err = !!parseShorthand(c.value).error;
                    return <td key={i} className="p-1 text-center"><input value={c.value} onChange={(e) => setCells((cs) => cs.map((x, j) => (j === i ? { ...x, value: e.target.value, edited: true } : x)))} placeholder="—" className={`w-16 text-center rounded border px-1 py-1 ${err ? "border-red-400 bg-red-50" : "border-gray-200"}`} /></td>;
                  })}
                  <td className="p-2 text-right font-medium">{fmtHrs(total)}</td>
                </tr></tbody>
              </table>
            </div>
          </>
        )}
        <div className="flex gap-2 mt-4">
          <Form method="post">
            <input type="hidden" name="intent" value="approve-schedule-request" />
            <input type="hidden" name="requestId" value={req.id} />
            <input type="hidden" name="cells" value={JSON.stringify(postCells)} />
            <button className="btn btn-primary btn-sm" disabled={isSubmitting || cells.length === 0}>Approve</button>
          </Form>
          <button type="button" className="btn btn-secondary btn-sm text-red-600" onClick={() => setDenying((d) => !d)}>Deny</button>
        </div>
        {denying && (
          <Form method="post" className="mt-3 flex flex-wrap items-end gap-2">
            <input type="hidden" name="intent" value="deny-schedule-request" />
            <input type="hidden" name="requestId" value={req.id} />
            <div className="flex-1 min-w-[240px]"><label className="form-label text-xs">Reason (optional, sent to worker)</label><input type="text" name="note" className="form-input" /></div>
            <button className="btn btn-primary btn-sm" disabled={isSubmitting}>Confirm deny</button>
          </Form>
        )}
      </div>
    </div>
  );
}
