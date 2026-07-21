import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Form, useNavigation, Link } from "react-router";
import { useState } from "react";
import { requireRole } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import {
  getFulfilledInRange,
  aggregateFulfilled,
  isShopifySyncing,
  type FulfilledReport,
} from "../utils/shopify.server";

// Today's calendar day in US Mountain Time (matches how fulfillments are bucketed).
const MT_TODAY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Denver",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function mountainToday(): string {
  return MT_TODAY_FMT.format(new Date());
}

const csvCell = (v: string | number) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// A valid YYYY-MM-DD, or null.
function cleanYmd(v: string | null): string | null {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN", "MANAGER"]);
  const url = new URL(request.url);
  const today = mountainToday();

  // Backwards compatible with the old single-date `?date=` links.
  const legacy = cleanYmd(url.searchParams.get("date"));
  let from = cleanYmd(url.searchParams.get("from")) || legacy || today;
  let to = cleanYmd(url.searchParams.get("to")) || legacy || today;
  if (from > to) [from, to] = [to, from]; // tolerate a reversed range

  let report: FulfilledReport | null = null;
  let error: string | null = null;
  try {
    const items = await getFulfilledInRange(from, to);
    report = aggregateFulfilled(items, from, to);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // CSV export of the per-SKU breakdown for the selected range.
  if (report && url.searchParams.get("format") === "csv") {
    const header = ["SKU", "Product", "ShipHero", "Utah", "Total"];
    const rows = report.bySku.map((r) => [r.sku, r.title, r.shiphero, r.utah, r.total]);
    const totals = ["TOTAL", "", report.shiphero.units, report.utah.units, report.totalUnits];
    const csv = [header, ...rows, totals]
      .map((r) => r.map(csvCell).join(","))
      .join("\n");
    const stamp = from === to ? from : `${from}_to_${to}`;
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="fulfilled-orders_${stamp}.csv"`,
      },
    });
  }

  return { user, report, error, from, to, syncing: isShopifySyncing() };
};

const num = (n: number) => n.toLocaleString();

const fmtDay = (ymd: string) =>
  new Date(`${ymd}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

type SortKey = "sku" | "title" | "shiphero" | "utah" | "total";
type SortDir = "asc" | "desc";

export default function FulfilledOrders() {
  const { user, report, error, from, to, syncing } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";

  const [sortKey, setSortKey] = useState<SortKey>("total");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Text columns default A→Z; number columns default high→low.
      setSortDir(key === "sku" || key === "title" ? "asc" : "desc");
    }
  };

  const sortedSkus = report
    ? [...report.bySku].sort((a, b) => {
        let cmp: number;
        if (sortKey === "sku") cmp = a.sku.localeCompare(b.sku);
        else if (sortKey === "title") cmp = a.title.localeCompare(b.title);
        else cmp = a[sortKey] - b[sortKey];
        if (cmp === 0) cmp = a.sku.localeCompare(b.sku); // stable tiebreak
        return sortDir === "asc" ? cmp : -cmp;
      })
    : [];

  const arrow = (key: SortKey) =>
    key === sortKey ? (sortDir === "asc" ? " ▲" : " ▼") : "";

  const rangeLabel =
    from === to ? fmtDay(from) : `${fmtDay(from)} — ${fmtDay(to)}`;

  const exportHref = `/fulfilled-orders?from=${from}&to=${to}&format=csv`;

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Fulfilled Orders</h1>
        <p className="page-subtitle">
          Orders shipped over a date range, by SKU, split by ShipHero vs. Utah (in-house).
          Both the Bowmar Archery and Beast Broadhead stores.
        </p>
      </div>

      {/* Date range + controls (single inline row) */}
      <div className="card mb-4">
        <div className="card-body">
          <Form method="get" className="flex items-end gap-3 flex-wrap">
            <div className="form-group mb-0">
              <label className="form-label">From (Mountain Time)</label>
              <input
                type="date"
                name="from"
                defaultValue={from}
                max={mountainToday()}
                className="form-input"
              />
            </div>
            <div className="form-group mb-0">
              <label className="form-label">To</label>
              <input
                type="date"
                name="to"
                defaultValue={to}
                max={mountainToday()}
                className="form-input"
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={isLoading}>
              {isLoading ? "Loading…" : "View"}
            </button>
            {report && report.totalUnits > 0 && (
              <Link to={exportHref} reloadDocument className="btn btn-secondary">
                Export CSV
              </Link>
            )}
            {syncing && (
              <span className="badge badge-blue">Syncing with Shopify… refresh in a moment</span>
            )}
          </Form>
        </div>
      </div>

      {error && (
        <div className="alert alert-error mb-4">
          Couldn't load fulfillments from Shopify: {error}
        </div>
      )}

      {report && (
        <>
          <p className="text-sm text-gray-500 mb-3">{rangeLabel}</p>

          {/* Summary tiles */}
          <div className="stats-grid mb-6">
            <div className="stat-card">
              <div className="stat-label">Orders Fulfilled</div>
              <div className="stat-value">{num(report.totalOrders)}</div>
              <div className="text-sm text-gray-500 mt-1">{num(report.totalUnits)} units total</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">ShipHero</div>
              <div className="stat-value text-blue-600">{num(report.shiphero.units)}</div>
              <div className="text-sm text-gray-500 mt-1">
                units across {num(report.shiphero.orders)} orders
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Utah (in-house)</div>
              <div className="stat-value text-green-600">{num(report.utah.units)}</div>
              <div className="text-sm text-gray-500 mt-1">
                units across {num(report.utah.orders)} orders
              </div>
            </div>
          </div>

          {/* Per-SKU breakdown — click a column header to sort */}
          <div className="card mb-6">
            <div className="card-header">
              <h2 className="card-title">By SKU ({report.bySku.length})</h2>
            </div>
            <div className="card-body overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="cursor-pointer select-none" onClick={() => toggleSort("sku")}>
                      SKU{arrow("sku")}
                    </th>
                    <th className="cursor-pointer select-none" onClick={() => toggleSort("title")}>
                      Product{arrow("title")}
                    </th>
                    <th className="cursor-pointer select-none text-right" onClick={() => toggleSort("shiphero")}>
                      ShipHero{arrow("shiphero")}
                    </th>
                    <th className="cursor-pointer select-none text-right" onClick={() => toggleSort("utah")}>
                      Utah{arrow("utah")}
                    </th>
                    <th className="cursor-pointer select-none text-right" onClick={() => toggleSort("total")}>
                      Total{arrow("total")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedSkus.map((r) => (
                    <tr key={r.sku}>
                      <td className="font-mono text-sm">{r.sku}</td>
                      <td className="text-sm">{r.title}</td>
                      <td className="text-right text-blue-600">{r.shiphero ? num(r.shiphero) : "—"}</td>
                      <td className="text-right text-green-600">{r.utah ? num(r.utah) : "—"}</td>
                      <td className="text-right font-bold">{num(r.total)}</td>
                    </tr>
                  ))}
                  {report.bySku.length === 0 && (
                    <tr>
                      <td colSpan={5} className="text-center text-gray-500 py-6">
                        No orders were fulfilled in this range.
                      </td>
                    </tr>
                  )}
                </tbody>
                {report.bySku.length > 0 && (
                  <tfoot>
                    <tr className="font-bold">
                      <td colSpan={2} className="text-right">Total</td>
                      <td className="text-right text-blue-600">{num(report.shiphero.units)}</td>
                      <td className="text-right text-green-600">{num(report.utah.units)}</td>
                      <td className="text-right">{num(report.totalUnits)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>

          {/* Transparency: exactly which app/service marked each fulfillment (the
              Shopify timeline actor, e.g. "ShipHero Inventory & Shipping" vs
              "OD Auto-Fulfill") and where it shipped from. The location is "Utah"
              for both channels, so the ShipHero/Utah split is decided by Service,
              not Location. Confirm it here — anything misclassified can be tuned via
              the SHIPHERO_SERVICE_MATCH env var. */}
          {report.byService.length > 0 && (
            <div className="card mb-6">
              <div className="card-header">
                <h2 className="card-title">Fulfilled by (as labeled in Shopify)</h2>
              </div>
              <div className="card-body overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Service / App</th>
                      <th>Location</th>
                      <th>Counted as</th>
                      <th className="text-right">Orders</th>
                      <th className="text-right">Units</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byService.map((s) => (
                      <tr key={`${s.label}|${s.location ?? ""}`}>
                        <td className="text-sm">{s.label}</td>
                        <td className="text-sm text-gray-500">{s.location ?? "—"}</td>
                        <td>
                          <span className={`badge ${s.channel === "shiphero" ? "badge-blue" : "badge-green"}`}>
                            {s.channel === "shiphero" ? "ShipHero" : "Utah"}
                          </span>
                        </td>
                        <td className="text-right">{num(s.orders)}</td>
                        <td className="text-right">{num(s.units)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </Layout>
  );
}
