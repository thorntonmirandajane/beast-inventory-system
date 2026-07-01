import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Link } from "react-router";
import { requireRole } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";

const ymd = (d: Date | null) => (d ? new Date(d).toISOString().split("T")[0] : "");
const csvCell = (v: string | number | null | undefined) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

type Dup = {
  entryId: string;
  worker: string;
  date: string;
  sku: string;
  name: string;
  quantity: number;
  applied: number; // how many PRODUCED movements exist
  expected: number; // how many lines actually produce it
  extra: number; // applied - expected
  extraUnits: number; // extra * quantity
  firstApplied: string;
  lastApplied: string;
};

// Finds duplicate PRODUCED movements: an entry that produced the same SKU+qty
// more times than it has lines for it = re-approval double-apply (the "840" bug).
async function findDuplicates(): Promise<Dup[]> {
  const movements = await prisma.inventoryLog.findMany({
    where: { action: "PRODUCED", relatedResourceType: "TIME_ENTRY", relatedResource: { not: null } },
    select: { relatedResource: true, skuId: true, quantity: true, createdAt: true, sku: { select: { sku: true, name: true } } },
  });
  if (movements.length === 0) return [];

  const entryIds = Array.from(new Set(movements.map((m) => m.relatedResource!)));
  const entries = await prisma.workerTimeEntry.findMany({
    where: { id: { in: entryIds } },
    select: {
      id: true,
      clockInTime: true,
      user: { select: { firstName: true, lastName: true } },
      lines: {
        where: { isMisc: false, skuId: { not: null } },
        select: { skuId: true, quantityCompleted: true, adminAdjustedQuantity: true, isRejected: true, rejectionQuantity: true },
      },
    },
  });
  const entryById = new Map(entries.map((e) => [e.id, e]));

  // expected: how many lines produce (entry, sku, finalQty)
  const expected = new Map<string, number>();
  for (const e of entries) {
    for (const l of e.lines) {
      const base = l.adminAdjustedQuantity ?? l.quantityCompleted;
      const finalQty = l.isRejected ? 0 : base - (l.rejectionQuantity ?? 0);
      if (finalQty <= 0) continue;
      const k = `${e.id}|${l.skuId}|${finalQty}`;
      expected.set(k, (expected.get(k) ?? 0) + 1);
    }
  }

  // actual: PRODUCED movements grouped by (entry, sku, qty)
  const actual = new Map<string, { entryId: string; skuId: string; quantity: number; count: number; sku: string; name: string; times: number[] }>();
  for (const m of movements) {
    const k = `${m.relatedResource}|${m.skuId}|${m.quantity}`;
    const cur = actual.get(k) ?? { entryId: m.relatedResource!, skuId: m.skuId, quantity: m.quantity, count: 0, sku: m.sku.sku, name: m.sku.name, times: [] };
    cur.count++;
    cur.times.push(new Date(m.createdAt).getTime());
    actual.set(k, cur);
  }

  const dups: Dup[] = [];
  for (const [k, a] of actual) {
    const exp = expected.get(k) ?? 0;
    if (a.count > exp) {
      const entry = entryById.get(a.entryId);
      const times = a.times.sort((x, y) => x - y);
      dups.push({
        entryId: a.entryId,
        worker: entry ? `${entry.user.firstName} ${entry.user.lastName}` : "—",
        date: entry ? ymd(entry.clockInTime) : "",
        sku: a.sku,
        name: a.name,
        quantity: a.quantity,
        applied: a.count,
        expected: exp,
        extra: a.count - exp,
        extraUnits: (a.count - exp) * a.quantity,
        firstApplied: new Date(times[0]).toLocaleString(),
        lastApplied: new Date(times[times.length - 1]).toLocaleString(),
      });
    }
  }
  dups.sort((a, b) => b.extraUnits - a.extraUnits);
  return dups;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN", "MANAGER"]);
  const dups = await findDuplicates();

  if (new URL(request.url).searchParams.get("format") === "csv") {
    const header = ["Date", "Worker", "SKU", "Name", "Qty", "Applied", "Expected", "Extra movements", "Over-produced units", "First applied", "Last applied", "Entry ID"];
    const rows = dups.map((d) => [d.date, d.worker, d.sku, d.name, d.quantity, d.applied, d.expected, d.extra, d.extraUnits, d.firstApplied, d.lastApplied, d.entryId]);
    const csv = [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
    return new Response(csv, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="duplicate-movements.csv"` },
    });
  }

  // Per-SKU rollup
  const bySkuMap = new Map<string, { sku: string; name: string; extraUnits: number; instances: number }>();
  for (const d of dups) {
    const g = bySkuMap.get(d.sku) ?? { sku: d.sku, name: d.name, extraUnits: 0, instances: 0 };
    g.extraUnits += d.extraUnits;
    g.instances += d.extra;
    bySkuMap.set(d.sku, g);
  }
  const bySku = Array.from(bySkuMap.values()).sort((a, b) => b.extraUnits - a.extraUnits);
  const totalExtraUnits = dups.reduce((s, d) => s + d.extraUnits, 0);

  return { user, dups, bySku, totalExtraUnits };
};

export default function DuplicateMovements() {
  const { user, dups, bySku, totalExtraUnits } = useLoaderData<typeof loader>();

  return (
    <Layout user={user}>
      <div className="page-header flex items-start justify-between">
        <div>
          <h1 className="page-title">Duplicate Movement Report</h1>
          <p className="page-subtitle">
            Time entries that produced the same SKU more times than they have tasks — the re-approval double-apply.
            Each row's <strong>over-produced units</strong> were added to inventory in error.
          </p>
        </div>
        <a href="/reports/duplicate-movements?format=csv" className="btn btn-secondary">Download CSV</a>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="card"><div className="card-body"><div className="stat-value">{dups.length}</div><div className="stat-label">Duplicate instances</div></div></div>
        <div className="card"><div className="card-body"><div className="stat-value">{bySku.length}</div><div className="stat-label">SKUs affected</div></div></div>
        <div className="card"><div className="card-body"><div className="stat-value" style={{ color: totalExtraUnits > 0 ? "#ef4444" : "#10b981" }}>{totalExtraUnits.toLocaleString()}</div><div className="stat-label">Over-produced units</div></div></div>
      </div>

      {dups.length === 0 ? (
        <div className="card"><div className="card-body text-center py-10 text-green-600">✓ No duplicate movements found. Inventory production matches approved tasks.</div></div>
      ) : (
        <>
          <div className="card mb-6">
            <div className="card-header"><h2 className="card-title">By SKU — units to correct</h2></div>
            <div className="card-body overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>SKU</th><th>Name</th><th className="text-right">Over-produced units</th><th className="text-right">Duplicate instances</th></tr></thead>
                <tbody>
                  {bySku.map((g) => (
                    <tr key={g.sku}>
                      <td className="font-mono text-sm">{g.sku}</td>
                      <td className="text-sm">{g.name}</td>
                      <td className="text-right font-bold text-red-600">{g.extraUnits.toLocaleString()}</td>
                      <td className="text-right">{g.instances}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-header"><h2 className="card-title">Every instance ({dups.length})</h2></div>
            <div className="card-body overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr><th>Date</th><th>Worker</th><th>SKU</th><th className="text-right">Qty</th><th className="text-right">Applied</th><th className="text-right">Should be</th><th className="text-right">Extra units</th><th>When (first → last)</th></tr>
                </thead>
                <tbody>
                  {dups.map((d, i) => (
                    <tr key={i}>
                      <td className="text-sm">{d.date}</td>
                      <td className="text-sm">{d.worker}</td>
                      <td className="font-mono text-sm">{d.sku}</td>
                      <td className="text-right">{d.quantity.toLocaleString()}</td>
                      <td className="text-right font-semibold text-red-600">{d.applied}×</td>
                      <td className="text-right">{d.expected}×</td>
                      <td className="text-right font-bold text-red-600">{d.extraUnits.toLocaleString()}</td>
                      <td className="text-xs text-gray-500">{d.firstApplied} → {d.lastApplied}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-gray-500 mt-3">
                "Applied 2×, should be 1×" means the entry moved that production twice. Those entries also
                <strong> double-consumed the components</strong>, so recount both the SKU above and its BOM parts
                (Import Counts) to true up. The re-approval fix stops new duplicates going forward.
              </p>
            </div>
          </div>
        </>
      )}
    </Layout>
  );
}
