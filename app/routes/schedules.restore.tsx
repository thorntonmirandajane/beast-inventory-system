import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation, Link } from "react-router";
import { requireRole, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { toShorthand } from "../utils/schedule-hours";

// ============================================================================
// Schedule recovery.
//
// "Save week (commit pre-filled)" used to write every cell the browser was
// showing, and a cell showing nothing cleared that day — so one click on a
// stale grid could wipe a week of approved hours.
//
// The hours survive that: approving a request rewrites the request's `days`
// with the exact cells committed, and commit-week never touches
// schedule_requests. This page reads those requests back and refills days that
// are currently empty. It never overwrites a day that still has hours.
// ============================================================================

type Shift = { start: string; end: string };

const ymd = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
};
const addDays = (d: Date, n: number) => { const r = new Date(d); r.setDate(r.getDate() + n); r.setHours(12, 0, 0, 0); return r; };
const mondayOf = (d: Date) => { const r = new Date(d); const dow = r.getDay(); r.setDate(r.getDate() + (dow === 0 ? -6 : 1 - dow)); r.setHours(12, 0, 0, 0); return r; };
const dateAtNoon = (s: string) => new Date(`${s}T12:00:00`);
const label = (shifts: Shift[]) => shifts.map((s) => toShorthand(s.start, s.end)).join(", ");

function cellShifts(c: any): Shift[] {
  if (Array.isArray(c?.shifts)) return c.shifts.filter((s: any) => s?.start && s?.end);
  if (c?.start && c?.end) return [{ start: c.start, end: c.end }];
  return [];
}

/** Best recoverable record per (worker, date): newest approved wins, else pending. */
async function recoverable(weekDates: string[]) {
  const requests = await prisma.scheduleRequest.findMany({
    orderBy: [{ reviewedAt: "desc" }, { submittedAt: "desc" }],
  });
  const found = new Map<string, { shifts: Shift[]; off: boolean; status: string; when: Date | null }>();
  for (const req of requests) {
    let cells: any[] = [];
    try { cells = JSON.parse(req.days)?.cells ?? []; } catch { continue; }
    for (const c of cells) {
      if (!c?.date || !weekDates.includes(c.date)) continue;
      const k = `${req.userId}|${c.date}`;
      const prior = found.get(k);
      // An approved record always beats a pending one; otherwise first (newest) wins.
      if (prior && (prior.status === "APPROVED" || req.status !== "APPROVED")) continue;
      const shifts = cellShifts(c);
      if (!shifts.length && c?.off !== true) continue;
      found.set(k, { shifts, off: c?.off === true, status: req.status, when: req.reviewedAt ?? req.submittedAt });
    }
  }
  return found;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN"]);
  const url = new URL(request.url);
  const wsParam = url.searchParams.get("weekStart");
  const monday = mondayOf(wsParam && /^\d{4}-\d{2}-\d{2}$/.test(wsParam) ? dateAtNoon(wsParam) : new Date());
  const weekDates = Array.from({ length: 7 }, (_, i) => ymd(addDays(monday, i)));
  const rangeStart = dateAtNoon(weekDates[0]); rangeStart.setHours(0, 0, 0, 0);
  const rangeEnd = dateAtNoon(weekDates[6]); rangeEnd.setHours(23, 59, 59, 999);

  const workers = await prisma.user.findMany({
    where: { isActive: true, OR: [{ role: "WORKER" }, { showOnSchedule: true }] },
    select: { id: true, firstName: true, lastName: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  const nameById = new Map(workers.map((w) => [w.id, `${w.firstName} ${w.lastName}`]));

  const liveRows = await prisma.workerSchedule.findMany({
    where: { scheduleType: "SPECIFIC_DATE", isActive: true, scheduleDate: { gte: rangeStart, lte: rangeEnd } },
    select: { userId: true, scheduleDate: true, startTime: true, endTime: true },
  });
  const live = new Map<string, Shift[]>();
  for (const r of liveRows) if (r.scheduleDate) {
    const k = `${r.userId}|${ymd(r.scheduleDate)}`;
    const a = live.get(k) ?? [];
    a.push({ start: r.startTime, end: r.endTime });
    live.set(k, a);
  }
  const offRows = await prisma.scheduleDayOff.findMany({
    where: { date: { gte: rangeStart, lte: rangeEnd } },
    select: { userId: true, date: true },
  });
  const liveOff = new Set(offRows.map((r) => `${r.userId}|${ymd(r.date)}`));

  const found = await recoverable(weekDates);
  const rows = [...found.entries()]
    .filter(([k]) => nameById.has(k.split("|")[0]))
    .map(([k, v]) => {
      const [userId, date] = k.split("|");
      const current = live.get(k) ?? [];
      const hasLive = current.length > 0 || liveOff.has(k);
      return {
        userId, date,
        worker: nameById.get(userId) ?? userId,
        recovered: v.off ? "Off" : label(v.shifts.sort((a, b) => a.start.localeCompare(b.start))),
        source: v.status,
        when: v.when ? ymd(new Date(v.when)) : null,
        current: current.length ? label(current.sort((a, b) => a.start.localeCompare(b.start))) : liveOff.has(k) ? "Off" : "",
        missing: !hasLive,
      };
    })
    .sort((a, b) => a.worker.localeCompare(b.worker) || a.date.localeCompare(b.date));

  return {
    user,
    weekStart: weekDates[0],
    weekEnd: weekDates[6],
    prevWeek: ymd(addDays(monday, -7)),
    nextWeek: ymd(addDays(monday, 7)),
    rows,
    missingCount: rows.filter((r) => r.missing).length,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN"]);
  const form = await request.formData();
  if (form.get("intent") !== "restore") return { error: "Unknown action" };

  const weekStart = String(form.get("weekStart") || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return { error: "Bad week." };
  const monday = mondayOf(dateAtNoon(weekStart));
  const weekDates = Array.from({ length: 7 }, (_, i) => ymd(addDays(monday, i)));
  const rangeStart = dateAtNoon(weekDates[0]); rangeStart.setHours(0, 0, 0, 0);
  const rangeEnd = dateAtNoon(weekDates[6]); rangeEnd.setHours(23, 59, 59, 999);

  const found = await recoverable(weekDates);

  // Only fill days that are empty right now. A day someone has already redone
  // by hand is left exactly as it is.
  const liveRows = await prisma.workerSchedule.findMany({
    where: { scheduleType: "SPECIFIC_DATE", isActive: true, scheduleDate: { gte: rangeStart, lte: rangeEnd } },
    select: { userId: true, scheduleDate: true },
  });
  const occupied = new Set(liveRows.filter((r) => r.scheduleDate).map((r) => `${r.userId}|${ymd(r.scheduleDate!)}`));
  const offRows = await prisma.scheduleDayOff.findMany({
    where: { date: { gte: rangeStart, lte: rangeEnd } },
    select: { userId: true, date: true },
  });
  for (const r of offRows) occupied.add(`${r.userId}|${ymd(r.date)}`);

  let restored = 0;
  await prisma.$transaction(async (tx) => {
    for (const [k, v] of found) {
      if (occupied.has(k)) continue;
      const [userId, date] = k.split("|");
      const scheduleDate = dateAtNoon(date);
      for (const s of v.shifts) {
        await tx.workerSchedule.create({
          data: { userId, dayOfWeek: null, scheduleDate, scheduleType: "SPECIFIC_DATE", startTime: s.start, endTime: s.end, isActive: true },
        });
      }
      if (!v.shifts.length && v.off) {
        await tx.scheduleDayOff.create({ data: { userId, date: scheduleDate } });
      }
      restored++;
    }
  }, { timeout: 120000, maxWait: 15000 });

  await createAuditLog(user.id, "RESTORE_SCHEDULE_WEEK", "WorkerSchedule", weekStart, { daysRestored: restored });
  return { success: true, message: `Restored ${restored} day(s) for the week of ${weekStart}.` };
};

export default function SchedulesRestore() {
  const { user, weekStart, weekEnd, prevWeek, nextWeek, rows, missingCount } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Restore schedule week</h1>
        <p className="page-subtitle">
          Rebuilds a week from the workers' own submitted and approved requests. Only fills days that are
          empty right now — it never overwrites hours that are already there.
        </p>
      </div>

      {actionData && "error" in actionData && actionData.error && (
        <div className="alert alert-error mb-4">{actionData.error}</div>
      )}
      {actionData && "success" in actionData && actionData.success && (
        <div className="alert alert-success mb-4">{actionData.message}</div>
      )}

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Link to={`/schedules/restore?weekStart=${prevWeek}`} className="btn btn-secondary btn-sm">←</Link>
        <span className="font-semibold">{weekStart} – {weekEnd}</span>
        <Link to={`/schedules/restore?weekStart=${nextWeek}`} className="btn btn-secondary btn-sm">→</Link>
        <Link to={`/schedules?view=week&weekStart=${weekStart}`} className="btn btn-secondary btn-sm">Back to the grid</Link>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">
            {rows.length} day(s) found in request history · {missingCount} missing from the schedule
          </span>
          {missingCount > 0 && (
            <Form method="post" onSubmit={(e) => { if (!confirm(`Restore ${missingCount} missing day(s) for ${weekStart} – ${weekEnd}?`)) e.preventDefault(); }}>
              <input type="hidden" name="intent" value="restore" />
              <input type="hidden" name="weekStart" value={weekStart} />
              <button className="btn btn-primary btn-sm" disabled={busy}>
                {busy ? "Restoring…" : `Restore ${missingCount} missing day(s)`}
              </button>
            </Form>
          )}
        </div>
        <div className="card-body">
          {rows.length === 0 ? (
            <p className="text-gray-500">
              No submitted or approved requests cover this week, so there's nothing to rebuild it from.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr><th>Worker</th><th>Date</th><th>From request</th><th>Source</th><th>On the schedule now</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.userId}|${r.date}`}>
                      <td>{r.worker}</td>
                      <td>{r.date}</td>
                      <td className="font-medium">{r.recovered}</td>
                      <td><span className="text-xs text-gray-500">{r.source}{r.when ? ` · ${r.when}` : ""}</span></td>
                      <td className={r.current ? "" : "text-gray-400"}>{r.current || "—"}</td>
                      <td>
                        {r.missing
                          ? <span className="badge badge-red">missing — will restore</span>
                          : <span className="badge badge-gray">already there</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
