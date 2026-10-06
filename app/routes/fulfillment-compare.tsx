import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Form, useNavigation, Link, useSearchParams } from "react-router";
import { useState } from "react";
import { requireRole } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import { compareStrategies, type StrategyResult } from "../utils/fulfillment-strategy.server";
import { STRATEGIES, type StrategyKind } from "../utils/strategy-kinds";

const DEFAULT_KINDS: StrategyKind[] = ["FULL_FIRST_THEN_PARTIAL", "OLDEST_FIRST", "FULL_ONLY"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN", "MANAGER"]);
  const url = new URL(request.url);

  const picked = url.searchParams.getAll("s").filter((k) => STRATEGIES.some((s) => s.kind === k)) as StrategyKind[];
  const kinds = picked.length ? picked : DEFAULT_KINDS;
  const location = url.searchParams.get("location") === "UTAH" ? "UTAH" : "GALLATIN";
  const storeFilter = url.searchParams.get("store") || "all";
  const customers = (url.searchParams.get("customers") || "")
    .split(",").map((c) => c.trim()).filter(Boolean);

  let data = null;
  let error: string | null = null;
  try {
    data = await compareStrategies({ kinds, location, storeFilter, priorityCustomers: customers });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return { user, data, error, kinds, location, storeFilter, customers: customers.join(", ") };
};

const num = (n: number) => n.toLocaleString();
const money = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

function StrategyCard({ r, totalOrders, totalUnits, totalValue, best }: {
  r: StrategyResult; totalOrders: number; totalUnits: number; totalValue: number; best: Record<string, boolean>;
}) {
  const Stat = ({ label, value, sub, flag }: { label: string; value: string; sub?: string; flag?: boolean }) => (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-xl font-bold ${flag ? "text-green-600" : "text-gray-900"}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400">{sub}</div>}
    </div>
  );
  return (
    <div className="card">
      <div className="card-header !py-3 block">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="card-title text-base">{r.label}</span>
          {best.orders && <span className="badge badge-green">most orders out</span>}
          {best.value && <span className="badge badge-blue">most value</span>}
        </div>
        <p className="text-xs text-gray-500 mt-1">{r.blurb}</p>
      </div>
      <div className="card-body space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Orders shipped whole" value={num(r.ordersFull)} sub={`${pct(r.ordersFull, totalOrders)}% of ${num(totalOrders)}`} flag={best.orders} />
          <Stat label="Part-filled" value={num(r.ordersPartial)} sub={`${num(r.ordersUntouched)} untouched`} />
          <Stat label="Units out" value={num(r.unitsShipped)} sub={`${pct(r.unitsShipped, totalUnits)}% of ${num(totalUnits)}`} />
          <Stat label="Value released" value={money(r.valueShipped)} sub={`${pct(r.valueShipped, totalValue)}% of ${money(totalValue)}`} flag={best.value} />
        </div>

        <div>
          <div className="text-xs font-semibold text-gray-500 mb-1">Which store gets served</div>
          <div className="overflow-x-auto">
            <table className="data-table text-sm">
              <thead><tr><th>Store</th><th>Whole</th><th>Part</th><th>Units</th><th>Value</th></tr></thead>
              <tbody>
                <tr>
                  <td><span className="badge badge-purple">Beast</span></td>
                  <td>{num(r.byStore.beast.ordersFull)}</td>
                  <td>{num(r.byStore.beast.ordersPartial)}</td>
                  <td>{num(r.byStore.beast.units)}</td>
                  <td>{money(r.byStore.beast.value)}</td>
                </tr>
                <tr>
                  <td><span className="badge badge-blue">Archery</span></td>
                  <td>{num(r.byStore.archery.ordersFull)}</td>
                  <td>{num(r.byStore.archery.ordersPartial)}</td>
                  <td>{num(r.byStore.archery.units)}</td>
                  <td>{money(r.byStore.archery.value)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="text-sm">
          <span className="text-gray-500">Left owing after this plan: </span>
          <span className="font-medium">{num(r.unitsRemaining)} units</span>
          <span className="text-gray-400"> · </span>
          <span className="font-medium">{money(r.valueRemaining)}</span>
        </div>
      </div>
    </div>
  );
}

export default function FulfillmentCompare() {
  const { user, data, error, kinds, location, storeFilter, customers } = useLoaderData<typeof loader>();
  const busy = useNavigation().state !== "idle";
  const [searchParams] = useSearchParams();
  const [showShortfallFor, setShowShortfallFor] = useState<StrategyKind | null>(null);

  const results = data?.results ?? [];
  const bestOrders = Math.max(0, ...results.map((r) => r.ordersFull));
  const bestValue = Math.max(0, ...results.map((r) => r.valueShipped));

  const shortfallOf = showShortfallFor
    ? results.find((r) => r.kind === showShortfallFor)
    : results[0];

  return (
    <Layout user={user}>
      <div className="page-header flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">Compare fulfillment strategies</h1>
          <p className="page-subtitle">
            Same backlog, same stock, different ways of handing it out. See what each approach actually clears —
            and what you'd still need to buy or build to finish the rest.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Link to="/unfulfilled" className="btn btn-secondary btn-sm">Unfulfilled orders</Link>
          <Link to="/fulfillment-plans" className="btn btn-secondary btn-sm">Game plans</Link>
        </div>
      </div>

      {error && <div className="alert alert-error mb-4">Couldn't run the comparison: {error}</div>}

      <Form method="get" className="card mb-4">
        <div className="card-body space-y-3">
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <label className="form-label">Ship from</label>
              <select name="location" defaultValue={location} className="form-select">
                <option value="GALLATIN">Gallatin</option>
                <option value="UTAH">Utah</option>
              </select>
            </div>
            <div>
              <label className="form-label">Stores</label>
              <select name="store" defaultValue={storeFilter} className="form-select">
                <option value="all">Both</option>
                <option value="beast">Beast only</option>
                <option value="archery">Archery only</option>
              </select>
            </div>
            <div>
              <label className="form-label">Priority customers</label>
              <input
                name="customers"
                defaultValue={customers}
                placeholder="Lancaster, Sportsman's…"
                className="form-input"
              />
              <p className="text-xs text-gray-500 mt-1">Comma separated — used by "Named customers first".</p>
            </div>
          </div>

          <div>
            <label className="form-label">Strategies to compare</label>
            <div className="grid gap-2 md:grid-cols-2">
              {STRATEGIES.map((s) => (
                <label key={s.kind} className="flex items-start gap-2 text-sm p-2 rounded-lg border border-gray-200">
                  <input type="checkbox" name="s" value={s.kind} defaultChecked={kinds.includes(s.kind)} className="mt-1" />
                  <span>
                    <span className="font-medium">{s.label}</span>
                    <span className="block text-xs text-gray-500">{s.blurb}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <button className="btn btn-primary" disabled={busy}>{busy ? "Running…" : "Run comparison"}</button>
        </div>
      </Form>

      {data && (
        <>
          <p className="text-sm text-gray-600 mb-3">
            Backlog: <strong>{num(data.totalOrders)}</strong> orders · <strong>{num(data.totalUnits)}</strong> units ·{" "}
            <strong>{money(data.totalValue)}</strong> — each strategy below starts from the same stock at{" "}
            {location === "UTAH" ? "Utah" : "Gallatin"}.
          </p>

          <div className="grid gap-4 xl:grid-cols-2 mb-6">
            {results.map((r) => (
              <StrategyCard
                key={r.kind}
                r={r}
                totalOrders={data.totalOrders}
                totalUnits={data.totalUnits}
                totalValue={data.totalValue}
                best={{
                  orders: r.ordersFull === bestOrders && bestOrders > 0,
                  value: r.valueShipped === bestValue && bestValue > 0,
                }}
              />
            ))}
            {results.length === 0 && (
              <div className="card"><div className="card-body text-gray-500">Pick at least one strategy above.</div></div>
            )}
          </div>

          {shortfallOf && (
            <div className="card">
              <div className="card-header flex-wrap gap-2">
                <span className="card-title">What's still needed to clear the rest</span>
                <select
                  value={shortfallOf.kind}
                  onChange={(e) => setShowShortfallFor(e.target.value as StrategyKind)}
                  className="form-select"
                  style={{ maxWidth: 280 }}
                >
                  {results.map((r) => <option key={r.kind} value={r.kind}>after {r.label}</option>)}
                </select>
              </div>
              <div className="card-body">
                <p className="text-sm text-gray-600 mb-3">
                  Once <strong>{shortfallOf.label.toLowerCase()}</strong> has taken its pass, this is what you'd have to
                  buy or build to finish every remaining order: <strong>{num(shortfallOf.shortfallUnits)}</strong> units
                  across <strong>{num(shortfallOf.shortfall.length)}</strong> SKUs.
                </p>
                <div className="overflow-x-auto">
                  <table className="data-table">
                    <thead><tr><th>SKU</th><th>Product</th><th>Still needed</th><th>Orders waiting on it</th></tr></thead>
                    <tbody>
                      {shortfallOf.shortfall.length === 0 && (
                        <tr><td colSpan={4} className="text-center text-gray-500 py-6">
                          Nothing — this strategy clears the whole backlog.
                        </td></tr>
                      )}
                      {shortfallOf.shortfall.map((r) => (
                        <tr key={r.sku}>
                          <td className="font-mono text-xs">{r.sku}</td>
                          <td>{r.title}</td>
                          <td className="font-medium text-red-600">{num(r.stillNeeded)}</td>
                          <td>{num(r.ordersWaiting)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </Layout>
  );
}
