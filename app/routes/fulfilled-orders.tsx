import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Form, useNavigation, Link } from "react-router";
import { requireRole } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import {
  getFulfilledOnDate,
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN", "MANAGER"]);
  const url = new URL(request.url);

  const date = url.searchParams.get("date") || mountainToday();

  let report: FulfilledReport | null = null;
  let error: string | null = null;
  try {
    const items = await getFulfilledOnDate(date);
    report = aggregateFulfilled(items, date);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // CSV export of the per-SKU breakdown for the selected day.
  if (report && url.searchParams.get("format") === "csv") {
    const header = ["SKU", "Product", "ShipHero", "Utah", "Total"];
    const rows = report.bySku.map((r) => [r.sku, r.title, r.shiphero, r.utah, r.total]);
    const totals = ["TOTAL", "", report.shiphero.units, report.utah.units, report.totalUnits];
    const csv = [header, ...rows, totals]
      .map((r) => r.map(csvCell).join(","))
      .join("\n");
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="fulfilled-orders_${date}.csv"`,
      },
    });
  }

  return { user, report, error, date, syncing: isShopifySyncing() };
};

const num = (n: number) => n.toLocaleString();

export default function FulfilledOrders() {
  const { user, report, error, date, syncing } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";

  const prettyDate = new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Fulfilled Orders</h1>
        <p className="page-subtitle">
          Orders shipped on a given day, by SKU, split by ShipHero vs. Utah (in-house).
          Both the Bowmar Archery and Beast Broadhead stores.
        </p>
      </div>

      {/* Date picker */}
      <div className="card mb-4">
        <div className="card-body flex flex-wrap items-end gap-4">
          <Form method="get" className="flex items-end gap-3 flex-wrap">
            <div className="form-group mb-0">
              <label className="form-label">Fulfillment date (Mountain Time)</label>
              <input
                type="date"
                name="date"
                defaultValue={date}
                max={mountainToday()}
                className="form-input"
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={isLoading}>
              {isLoading ? "Loading…" : "View"}
            </button>
          </Form>
          {report && report.totalUnits > 0 && (
            <Link
              to={`/fulfilled-orders?date=${date}&format=csv`}
              reloadDocument
              className="btn btn-secondary"
            >
              Export CSV
            </Link>
          )}
          {syncing && (
            <span className="badge badge-blue">Syncing with Shopify… refresh in a moment</span>
          )}
        </div>
      </div>

      {error && (
        <div className="alert alert-error mb-4">
          Couldn't load fulfillments from Shopify: {error}
        </div>
      )}

      {report && (
        <>
          <p className="text-sm text-gray-500 mb-3">{prettyDate}</p>

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

          {/* Per-SKU breakdown */}
          <div className="card mb-6">
            <div className="card-header">
              <h2 className="card-title">By SKU ({report.bySku.length})</h2>
            </div>
            <div className="card-body overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Product</th>
                    <th className="text-right">ShipHero</th>
                    <th className="text-right">Utah</th>
                    <th className="text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {report.bySku.map((r) => (
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
                        No orders were fulfilled on this day.
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

          {/* Transparency: exactly how each fulfillment service/location was labeled
              in Shopify, and which bucket it fell into. Confirm the ShipHero/Utah
              split here — anything misclassified can be tuned via SHIPHERO_SERVICE_MATCH. */}
          {report.byService.length > 0 && (
            <div className="card mb-6">
              <div className="card-header">
                <h2 className="card-title">Fulfilled by (as labeled in Shopify)</h2>
              </div>
              <div className="card-body overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Service / Location</th>
                      <th>Counted as</th>
                      <th className="text-right">Orders</th>
                      <th className="text-right">Units</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byService.map((s) => (
                      <tr key={s.label}>
                        <td className="text-sm">{s.label}</td>
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
