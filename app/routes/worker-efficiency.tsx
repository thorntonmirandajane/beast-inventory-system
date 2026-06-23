import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Form, Link } from "react-router";
import { requireUser } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";

// Flat rate for Expected Labor $ and the fallback when a worker has no pay rate.
const EXPECTED_RATE = 20;
const FALLBACK_RATE = 20;

type EntryLite = {
  userId: string;
  actualMinutes: number | null;
  expectedMinutes: number | null;
  miscMinutes: number;
  clockInTime: Date;
  clockOutTime: Date | null;
  lines: { processName: string; quantityCompleted: number; skuId: string | null; sku: { sku: string; name: string } | null }[];
};

// Core stats from a set of entries. Expected/actual are minutes; ratios are
// identical in hours, so we keep minutes for the math and expose hours.
function computeStats(entries: EntryLite[]) {
  let actual = 0,
    misc = 0,
    expected = 0;
  const processCounts: Record<string, number> = {};
  const skuCounts: Record<string, { sku: string; name: string; count: number }> = {};
  for (const e of entries) {
    actual += e.actualMinutes ?? 0;
    misc += e.miscMinutes ?? 0;
    expected += e.expectedMinutes ?? 0;
    for (const line of e.lines) {
      processCounts[line.processName] = (processCounts[line.processName] ?? 0) + line.quantityCompleted;
      if (line.skuId && line.sku) {
        const c = skuCounts[line.skuId] ?? { sku: line.sku.sku, name: line.sku.name, count: 0 };
        c.count += line.quantityCompleted;
        skuCounts[line.skuId] = c;
      }
    }
  }
  const trackable = Math.max(0, actual - misc);
  return {
    shifts: entries.length,
    totalHours: actual / 60,
    miscHours: misc / 60,
    trackableHours: trackable / 60,
    expectedHours: expected / 60,
    overall: actual > 0 ? (expected / actual) * 100 : null,
    trackableEff: trackable > 0 ? (expected / trackable) * 100 : null,
    miscPct: actual > 0 ? (misc / actual) * 100 : 0,
    topProcesses: Object.entries(processCounts).sort(([, a], [, b]) => b - a).slice(0, 3).map(([process, count]) => ({ process, count })),
    topSkus: Object.values(skuCounts).sort((a, b) => b.count - a.count).slice(0, 3),
  };
}

function ymd(d: Date) {
  return d.toISOString().split("T")[0];
}
function mondayOf(d: Date) {
  const day = d.getDay(); // 0 Sun .. 6 Sat
  const diff = day === 0 ? -6 : 1 - day;
  const m = new Date(d);
  m.setDate(d.getDate() + diff);
  m.setHours(0, 0, 0, 0);
  return m;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  if (user.role !== "ADMIN") throw new Response("Unauthorized", { status: 403 });

  const url = new URL(request.url);
  const view = url.searchParams.get("view") === "weekly" ? "weekly" : "range";
  const employeeId = url.searchParams.get("employeeId") || "all";

  // Effective date window depends on the view.
  let startDate: Date;
  let endDate: Date;
  let weekStart: Date | null = null;
  if (view === "weekly") {
    const ws = url.searchParams.get("weekStart");
    weekStart = ws ? mondayOf(new Date(`${ws}T12:00:00`)) : mondayOf(new Date());
    startDate = new Date(weekStart);
    endDate = new Date(weekStart);
    endDate.setDate(endDate.getDate() + 6);
    endDate.setHours(23, 59, 59, 999);
  } else {
    endDate = url.searchParams.get("endDate") ? new Date(url.searchParams.get("endDate")!) : new Date();
    endDate.setHours(23, 59, 59, 999);
    startDate = url.searchParams.get("startDate") ? new Date(url.searchParams.get("startDate")!) : new Date();
    if (!url.searchParams.get("startDate")) startDate.setDate(startDate.getDate() - 30);
    startDate.setHours(0, 0, 0, 0);
  }

  const users = await prisma.user.findMany({
    where: { isActive: true },
    select: { id: true, firstName: true, lastName: true, email: true, role: true, payRate: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  const entries = await prisma.workerTimeEntry.findMany({
    // Filter by clock-IN so misc/admin entries with a null clock-out still count.
    where: { status: "APPROVED", clockInTime: { gte: startDate, lte: endDate } },
    select: {
      userId: true,
      actualMinutes: true,
      expectedMinutes: true,
      miscMinutes: true,
      clockInTime: true,
      clockOutTime: true,
      lines: {
        select: { processName: true, quantityCompleted: true, skuId: true, sku: { select: { sku: true, name: true } } },
      },
    },
  });

  const byUser = new Map<string, EntryLite[]>();
  for (const e of entries) {
    const arr = byUser.get(e.userId) ?? [];
    arr.push(e);
    byUser.set(e.userId, arr);
  }

  // Per-worker stats + labor. Include role-WORKER roster plus anyone who logged
  // time (so managers with misc time show up, matching the spreadsheet).
  const rows = users
    .filter((u) => u.role === "WORKER" || byUser.has(u.id))
    .map((u) => {
      const s = computeStats(byUser.get(u.id) ?? []);
      const rate = u.payRate ?? FALLBACK_RATE;
      const laborCost = s.totalHours * rate;
      const expectedLabor = s.expectedHours * EXPECTED_RATE;
      return {
        workerId: u.id,
        name: `${u.lastName}, ${u.firstName}`,
        email: u.email,
        payRate: u.payRate,
        missingRate: u.payRate == null && s.shifts > 0,
        ...s,
        laborCost,
        expectedLabor,
        laborDiff: expectedLabor - laborCost,
      };
    });

  // Team aggregate (weighted — the correct headline, not a mean of percentages).
  const allEntries = rows.flatMap((r) => byUser.get(r.workerId) ?? []);
  const team = computeStats(allEntries);
  const teamLabor = rows.reduce((sum, r) => sum + r.laborCost, 0);
  const teamExpectedLabor = team.expectedHours * EXPECTED_RATE;
  const missingRateNames = rows.filter((r) => r.missingRate).map((r) => r.name);

  // Single Employee Summary target (All = team).
  const selected = employeeId !== "all" ? rows.find((r) => r.workerId === employeeId) : null;
  const summaryBlock = selected
    ? {
        label: selected.name,
        totalHours: selected.totalHours,
        miscHours: selected.miscHours,
        trackableHours: selected.trackableHours,
        expectedHours: selected.expectedHours,
        overall: selected.overall,
        trackableEff: selected.trackableEff,
        miscPct: selected.miscPct,
        totalLabor: selected.laborCost,
        expectedLabor: selected.expectedLabor,
        laborDiff: selected.laborDiff,
      }
    : {
        label: "All employees",
        totalHours: team.totalHours,
        miscHours: team.miscHours,
        trackableHours: team.trackableHours,
        expectedHours: team.expectedHours,
        overall: team.overall,
        trackableEff: team.trackableEff,
        miscPct: team.miscPct,
        totalLabor: teamLabor,
        expectedLabor: teamExpectedLabor,
        laborDiff: teamExpectedLabor - teamLabor,
      };

  // Weekly grid (Mon–Sun): per worker, per-day Overall efficiency + week totals.
  let weekly: null | {
    days: { label: string; date: string }[];
    rows: { name: string; cells: (number | null)[]; weeklyEff: number | null; weeklyHours: number }[];
    teamCells: (number | null)[];
    teamWeeklyEff: number | null;
    teamWeeklyHours: number;
  } = null;
  if (view === "weekly" && weekStart) {
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart!);
      d.setDate(d.getDate() + i);
      return { label: d.toLocaleDateString(undefined, { weekday: "short", month: "numeric", day: "numeric" }), date: ymd(d) };
    });
    const dayIndex = (e: EntryLite) => {
      const d = e.clockInTime ?? e.clockOutTime;
      return d ? days.findIndex((x) => x.date === ymd(new Date(d))) : -1;
    };
    // accumulate expected/actual minutes per worker per day, and team per day
    // Cells show TRACKABLE efficiency (Expected ÷ non-misc hours) so workers
    // pulled onto misc tasks aren't penalized. Weekly Hours stays total clocked.
    const teamExp = Array(7).fill(0);
    const teamAct = Array(7).fill(0);
    const teamMis = Array(7).fill(0);
    const eff = (exp: number, act: number, mis: number) => {
      const tr = act - mis;
      return tr > 0 ? (exp / tr) * 100 : null;
    };
    const weeklyRows = rows.map((r) => {
      const exp = Array(7).fill(0);
      const act = Array(7).fill(0);
      const mis = Array(7).fill(0);
      for (const e of byUser.get(r.workerId) ?? []) {
        const i = dayIndex(e);
        if (i < 0) continue;
        exp[i] += e.expectedMinutes ?? 0;
        act[i] += e.actualMinutes ?? 0;
        mis[i] += e.miscMinutes ?? 0;
        teamExp[i] += e.expectedMinutes ?? 0;
        teamAct[i] += e.actualMinutes ?? 0;
        teamMis[i] += e.miscMinutes ?? 0;
      }
      const cells = days.map((_, i) => eff(exp[i], act[i], mis[i]));
      const totAct = act.reduce((a, b) => a + b, 0);
      const totExp = exp.reduce((a, b) => a + b, 0);
      const totMis = mis.reduce((a, b) => a + b, 0);
      return {
        name: r.name,
        cells,
        weeklyEff: eff(totExp, totAct, totMis),
        weeklyHours: totAct / 60,
      };
    });
    const teamCells = days.map((_, i) => eff(teamExp[i], teamAct[i], teamMis[i]));
    const tAct = teamAct.reduce((a, b) => a + b, 0);
    const tExp = teamExp.reduce((a, b) => a + b, 0);
    const tMis = teamMis.reduce((a, b) => a + b, 0);
    weekly = {
      days,
      rows: weeklyRows,
      teamCells,
      teamWeeklyEff: eff(tExp, tAct, tMis),
      teamWeeklyHours: tAct / 60,
    };
  }

  const prevWeek = weekStart ? ymd(new Date(weekStart.getTime() - 7 * 86400000)) : null;
  const nextWeek = weekStart ? ymd(new Date(weekStart.getTime() + 7 * 86400000)) : null;

  return {
    user,
    view,
    employeeId,
    startDate: ymd(startDate),
    endDate: ymd(endDate),
    weekStart: weekStart ? ymd(weekStart) : null,
    prevWeek,
    nextWeek,
    rows: rows.sort((a, b) => a.name.localeCompare(b.name)),
    team,
    teamLabor,
    teamExpectedLabor,
    missingRateNames,
    summaryBlock,
    weekly,
    activeWorkers: rows.filter((r) => r.shifts > 0).length,
    totalShifts: rows.reduce((s, r) => s + r.shifts, 0),
  };
};

const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v)}%`);
const usd = (v: number) => `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
function effColor(v: number | null): string {
  if (v == null) return "#9ca3af";
  if (v >= 100) return "#10b981";
  if (v >= 80) return "#f59e0b";
  return "#ef4444";
}

export default function WorkerEfficiency() {
  const data = useLoaderData<typeof loader>();
  const { view, employeeId, rows, summaryBlock, weekly, missingRateNames } = data;

  const empOptions = (
    <select name="employeeId" defaultValue={employeeId} className="form-input">
      <option value="all">(All)</option>
      {rows.map((r) => (
        <option key={r.workerId} value={r.workerId}>{r.name}</option>
      ))}
    </select>
  );

  return (
    <Layout user={data.user}>
      <div className="page-header">
        <h1 className="page-title">Worker Efficiency</h1>
        <p className="page-subtitle">Trackable vs overall efficiency, labor cost, and weekly breakdown</p>
      </div>

      {/* View tabs */}
      <div className="tabs mb-4">
        <Link to={`/worker-efficiency?view=range&employeeId=${employeeId}`} className={`tab ${view === "range" ? "active" : ""}`}>
          Date Range
        </Link>
        <Link to={`/worker-efficiency?view=weekly&employeeId=${employeeId}`} className={`tab ${view === "weekly" ? "active" : ""}`}>
          Weekly
        </Link>
      </div>

      {/* Controls */}
      <div className="card mb-4">
        <div className="card-body">
          {view === "range" ? (
            <Form method="get" className="flex items-end gap-3 flex-wrap">
              <input type="hidden" name="view" value="range" />
              <div className="form-group mb-0">
                <label className="form-label">Start Date</label>
                <input type="date" name="startDate" defaultValue={data.startDate} className="form-input" />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">End Date</label>
                <input type="date" name="endDate" defaultValue={data.endDate} className="form-input" />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Employee</label>
                {empOptions}
              </div>
              <button type="submit" className="btn btn-primary">Update</button>
            </Form>
          ) : (
            <Form method="get" className="flex items-end gap-3 flex-wrap">
              <input type="hidden" name="view" value="weekly" />
              <div className="flex items-center gap-2">
                <Link to={`/worker-efficiency?view=weekly&employeeId=${employeeId}&weekStart=${data.prevWeek}`} className="btn btn-secondary">←</Link>
                <span className="text-sm font-medium px-2">Week of {data.weekStart}</span>
                <Link to={`/worker-efficiency?view=weekly&employeeId=${employeeId}&weekStart=${data.nextWeek}`} className="btn btn-secondary">→</Link>
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Jump to week (any date)</label>
                <input type="date" name="weekStart" defaultValue={data.weekStart ?? undefined} className="form-input" />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Employee</label>
                {empOptions}
              </div>
              <button type="submit" className="btn btn-primary">Go</button>
            </Form>
          )}
        </div>
      </div>

      {missingRateNames.length > 0 && (
        <div className="alert alert-warning mb-4 text-sm">
          <strong>{missingRateNames.length} worker(s) have no pay rate set</strong> — labor $ uses the
          ${FALLBACK_RATE}/hr fallback for them: {missingRateNames.join(", ")}.
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-4">
        <Card label="Active Workers" value={String(data.activeWorkers)} />
        <Card label="Total Shifts" value={String(data.totalShifts)} />
        <Card label="Total Hours" value={`${data.team.totalHours.toFixed(1)}h`} />
        <Card label="Overall Efficiency" value={pct(data.team.overall)} color={effColor(data.team.overall)} />
        <Card label="Trackable Efficiency" value={pct(data.team.trackableEff)} color={effColor(data.team.trackableEff)} />
      </div>

      {/* Single Employee Summary */}
      <div className="card mb-4">
        <div className="card-header">
          <h2 className="card-title">Summary — {summaryBlock.label}</h2>
        </div>
        <div className="card-body grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-2 text-sm">
          <div>
            <Line k="Total Hours" v={`${summaryBlock.totalHours.toFixed(2)}`} note="total clocked-in hours" />
            <Line k="Misc Hours" v={`${summaryBlock.miscHours.toFixed(2)}`} note="misc time reported" />
            <Line k="Trackable Hours" v={`${summaryBlock.trackableHours.toFixed(2)}`} note="non-misc time" />
            <Line k="Expected Hours" v={`${summaryBlock.expectedHours.toFixed(2)}`} note="labor we completed" />
            <Line k="Efficiency (trackable)" v={pct(summaryBlock.trackableEff)} bold />
            <Line k="Overall Efficiency" v={pct(summaryBlock.overall)} bold />
            <Line k="Misc % of Time" v={`${Math.round(summaryBlock.miscPct)}%`} />
          </div>
          <div>
            <Line k="Total Labor $" v={usd(summaryBlock.totalLabor)} note="actual hours × each person's pay rate" />
            <Line k={`Expected Labor $`} v={usd(summaryBlock.expectedLabor)} note={`expected hours × $${EXPECTED_RATE}/hr`} />
            <Line k="Difference $" v={usd(summaryBlock.laborDiff)} note="expected labor − total labor" bold color={summaryBlock.laborDiff >= 0 ? "#10b981" : "#ef4444"} />
          </div>
        </div>
      </div>

      {view === "range" ? <RangeTable rows={rows} /> : weekly ? <WeeklyGrid weekly={weekly} /> : null}
    </Layout>
  );
}

function Card({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="card">
      <div className="card-body">
        <div className="stat-value" style={color ? { color } : undefined}>{value}</div>
        <div className="stat-label">{label}</div>
      </div>
    </div>
  );
}

function Line({ k, v, note, bold, color }: { k: string; v: string; note?: string; bold?: boolean; color?: string }) {
  return (
    <div className="flex justify-between border-b last:border-0 py-1">
      <span className="text-gray-600">{k}{note && <span className="text-xs text-gray-400 ml-1">({note})</span>}</span>
      <span className={bold ? "font-bold" : "font-medium"} style={color ? { color } : undefined}>{v}</span>
    </div>
  );
}

function RangeTable({ rows }: { rows: ReturnType<typeof useLoaderData<typeof loader>>["rows"] }) {
  return (
    <div className="card">
      <div className="card-header"><h2 className="card-title">Team Summary</h2></div>
      <div className="card-body overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Employee</th>
              <th className="text-right">Pay $/hr</th>
              <th className="text-right">Total Hrs</th>
              <th className="text-right">Misc Hrs</th>
              <th className="text-right">Trackable Hrs</th>
              <th className="text-right">Expected Hrs</th>
              <th className="text-right" title="Expected ÷ non-misc hours — misc excluded">Trackable %</th>
              <th className="text-right" title="Expected ÷ all clocked hours">Overall %</th>
              <th className="text-right">Labor $</th>
              <th>Top Processes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.workerId}>
                <td className="font-medium">{r.name}</td>
                <td className="text-right">
                  {r.payRate == null ? <span className="text-amber-600" title="No rate set — using fallback">${FALLBACK_RATE}*</span> : `$${r.payRate}`}
                </td>
                <td className="text-right">{r.totalHours.toFixed(2)}</td>
                <td className="text-right">{r.miscHours.toFixed(2)}</td>
                <td className="text-right">{r.trackableHours.toFixed(2)}</td>
                <td className="text-right">{r.expectedHours.toFixed(2)}</td>
                <td className="text-right font-semibold" style={{ color: effColor(r.trackableEff) }}>{pct(r.trackableEff)}</td>
                <td className="text-right" style={{ color: effColor(r.overall) }}>{pct(r.overall)}</td>
                <td className="text-right">{usd(r.laborCost)}</td>
                <td className="text-xs text-gray-500">{r.topProcesses.map((p) => `${p.process}: ${p.count}`).join(", ")}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={10} className="text-center text-gray-500 py-6">No approved time entries in this range.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function WeeklyGrid({ weekly }: { weekly: NonNullable<ReturnType<typeof useLoaderData<typeof loader>>["weekly"]> }) {
  return (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">Weekly Team Efficiency (Trackable %)</h2>
        <p className="text-sm text-gray-500">Expected ÷ non-misc hours — misc time doesn't count against the score</p>
      </div>
      <div className="card-body overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Employee</th>
              {weekly.days.map((d) => <th key={d.date} className="text-right">{d.label}</th>)}
              <th className="text-right">Weekly Eff %</th>
              <th className="text-right">Weekly Hours</th>
            </tr>
          </thead>
          <tbody>
            {weekly.rows.map((r) => (
              <tr key={r.name}>
                <td className="font-medium">{r.name}</td>
                {r.cells.map((c, i) => (
                  <td key={i} className="text-right" style={{ color: effColor(c) }}>{c == null ? "" : pct(c)}</td>
                ))}
                <td className="text-right font-semibold" style={{ color: effColor(r.weeklyEff) }}>{pct(r.weeklyEff)}</td>
                <td className="text-right">{r.weeklyHours.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-bold border-t-2">
              <td>Team Total</td>
              {weekly.teamCells.map((c, i) => (
                <td key={i} className="text-right" style={{ color: effColor(c) }}>{c == null ? "" : pct(c)}</td>
              ))}
              <td className="text-right" style={{ color: effColor(weekly.teamWeeklyEff) }}>{pct(weekly.teamWeeklyEff)}</td>
              <td className="text-right">{weekly.teamWeeklyHours.toFixed(2)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
