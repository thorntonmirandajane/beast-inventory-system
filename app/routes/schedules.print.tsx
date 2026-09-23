import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { requireRole } from "../utils/auth.server";
import prisma from "../db.server";
import { toShorthand } from "../utils/schedule-hours";

const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d: Date, n: number) => { const r = new Date(d); r.setDate(r.getDate() + n); r.setHours(12, 0, 0, 0); return r; };
const mondayOf = (d: Date) => { const r = new Date(d); const dow = r.getDay(); r.setDate(r.getDate() + (dow === 0 ? -6 : 1 - dow)); r.setHours(12, 0, 0, 0); return r; };
const hhmmHours = (s: string, e: string) => { if (!s || !e) return 0; const [sh, sm] = s.split(":").map(Number); const [eh, em] = e.split(":").map(Number); return Math.max(0, eh + em / 60 - (sh + sm / 60)); };
const fmtHrs = (n: number) => String(Math.round(n * 100) / 100);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireRole(request, ["ADMIN", "MANAGER"]);
  const url = new URL(request.url);
  const wsParam = url.searchParams.get("weekStart");
  const monday = mondayOf(wsParam && /^\d{4}-\d{2}-\d{2}$/.test(wsParam) ? new Date(`${wsParam}T12:00:00`) : new Date());
  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const rangeStart = new Date(monday); rangeStart.setHours(0, 0, 0, 0);
  const rangeEnd = addDays(monday, 6); rangeEnd.setHours(23, 59, 59, 999);

  // Exclude admin-role accounts so the Print/Export matches the Weekly Grid.
  const workers = await prisma.user.findMany({ where: { isActive: true, role: { not: "ADMIN" } }, select: { id: true, firstName: true, lastName: true }, orderBy: [{ lastName: "asc" }, { firstName: "asc" }] });
  const rows = await prisma.workerSchedule.findMany({
    where: { userId: { in: workers.map((w) => w.id) }, scheduleType: "SPECIFIC_DATE", isActive: true, scheduleDate: { gte: rangeStart, lte: rangeEnd } },
    select: { userId: true, scheduleDate: true, startTime: true, endTime: true },
  });
  const byKey = new Map<string, { start: string; end: string }>();
  for (const r of rows) if (r.scheduleDate) byKey.set(`${r.userId}|${ymd(r.scheduleDate)}`, { start: r.startTime, end: r.endTime });

  const gridWorkers = workers.map((w) => ({
    name: `${w.firstName} ${w.lastName}`,
    cells: weekDates.map((d) => {
      const c = byKey.get(`${w.id}|${ymd(d)}`);
      return c ? { label: toShorthand(c.start, c.end), hours: hhmmHours(c.start, c.end) } : { label: "", hours: 0 };
    }),
  }));

  const days = weekDates.map((d) => ({ label: DAY_ABBR[d.getDay()], dom: d.getDate() }));
  const sun = addDays(monday, 6);
  const title = `${monday.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${sun.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${sun.getFullYear()}`;
  return { gridWorkers, days, title };
};

export default function SchedulePrint() {
  const { gridWorkers, days, title } = useLoaderData<typeof loader>();
  const dayTotal = (di: number) => gridWorkers.reduce((t, w) => t + w.cells[di].hours, 0);
  const rowTotal = (w: any) => w.cells.reduce((t: number, c: any) => t + c.hours, 0);
  const grand = days.reduce((t, _d, di) => t + dayTotal(di), 0);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif", color: "#111" }}>
      <style>{`
        @page { size: landscape; margin: 12mm; }
        @media print { .no-print { display: none !important; } }
        table { border-collapse: collapse; width: 100%; font-size: 12px; }
        th, td { border: 1px solid #cbd5e1; padding: 6px 8px; text-align: center; }
        th:first-child, td:first-child { text-align: left; white-space: nowrap; }
        tfoot td { font-weight: 700; background: #f1f5f9; }
      `}</style>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Worker Schedule — {title}</h1>
        <button className="no-print" onClick={() => window.print()} style={{ padding: "6px 14px", border: "1px solid #cbd5e1", borderRadius: 6, cursor: "pointer", background: "#fff" }}>
          Print / Save as PDF
        </button>
      </div>
      <table>
        <thead>
          <tr>
            <th>Worker</th>
            {days.map((d, i) => <th key={i}>{d.label} {d.dom}</th>)}
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {gridWorkers.map((w, i) => (
            <tr key={i}>
              <td>{w.name}</td>
              {w.cells.map((c, j) => <td key={j}>{c.label || "—"}</td>)}
              <td>{fmtHrs(rowTotal(w))}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Daily total</td>
            {days.map((_d, di) => <td key={di}>{fmtHrs(dayTotal(di))}</td>)}
            <td>{fmtHrs(grand)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
