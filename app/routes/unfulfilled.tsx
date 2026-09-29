import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation, Link } from "react-router";
import { useMemo, useState } from "react";
import { requireUser, requireRole } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import {
  loadUnfulfilledView,
  type UnfulfilledViewOrder,
  type ShipStatus,
} from "../utils/unfulfilled-view.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const view = await loadUnfulfilledView();
  return { user, view };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await requireRole(request, ["ADMIN", "MANAGER"]);
  const form = await request.formData();
  if (form.get("intent") === "refresh") {
    await loadUnfulfilledView({ force: true });
    return { success: true, message: "Refreshed from Shopify and ShipHero." };
  }
  return { error: "Unknown action." };
};

const num = (n: number) => n.toLocaleString();
const STATUS_LABEL: Record<ShipStatus, string> = { FULL: "Can ship", PARTIAL: "Partial", NONE: "Blocked" };
const STATUS_CLASS: Record<ShipStatus, string> = {
  FULL: "badge-green",
  PARTIAL: "badge-yellow",
  NONE: "badge-red",
};

function Kpi({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone ?? ""}`}>{typeof value === "number" ? num(value) : value}</div>
    </div>
  );
}

export default function Unfulfilled() {
  const { user, view } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";

  const [tab, setTab] = useState<"orders" | "skus">("orders");
  const [filter, setFilter] = useState<"all" | ShipStatus>("all");
  const [sort, setSort] = useState<"waiting_desc" | "waiting_asc">("waiting_desc");
  const [store, setStore] = useState<"all" | "beast" | "archery">("all");
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const orders = useMemo(() => {
    let rows = view.orders as UnfulfilledViewOrder[];
    if (filter !== "all") rows = rows.filter((o) => o.status === filter);
    if (store !== "all") rows = rows.filter((o) => o.store === store);
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      rows = rows.filter(
        (o) =>
          o.orderName.toLowerCase().includes(needle) ||
          (o.customerName || "").toLowerCase().includes(needle) ||
          (o.company || "").toLowerCase().includes(needle) ||
          o.lines.some((l) => l.sku.toLowerCase().includes(needle))
      );
    }
    return [...rows].sort((a, b) =>
      sort === "waiting_asc" ? a.ageDays - b.ageDays : b.ageDays - a.ageDays
    );
  }, [view.orders, filter, store, sort, q]);

  const skus = useMemo(() => {
    if (!q.trim()) return view.bySku;
    const needle = q.trim().toLowerCase();
    return view.bySku.filter(
      (r) => r.sku.toLowerCase().includes(needle) || (r.title || "").toLowerCase().includes(needle)
    );
  }, [view.bySku, q]);

  const t = view.totals;

  return (
    <Layout user={user}>
      <div className="page-header flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">Unfulfilled Orders</h1>
          <p className="page-subtitle">
            Open orders across both stores, and what could ship today from Gallatin or from Utah.
            Stock is allocated oldest order first, so no unit is promised twice.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Link to="/backorder" className="btn btn-secondary btn-sm">Backorder planning</Link>
          <Form method="post">
            <input type="hidden" name="intent" value="refresh" />
            <button className="btn btn-secondary btn-sm" disabled={busy}>
              {busy ? "Refreshing…" : "Refresh"}
            </button>
          </Form>
        </div>
      </div>

      {actionData && "message" in actionData && actionData.message && (
        <div className="alert alert-success mb-4">{actionData.message}</div>
      )}

      {/* A store that isn't wired up returns nothing rather than erroring, so say so. */}
      {view.problems.map((p, i) => (
        <div key={i} className="alert alert-warning mb-3">{p}</div>
      ))}

      <div className="stats-grid">
        <Kpi label="Unfulfilled orders" value={t.orders} />
        <Kpi label="Can ship (either site)" value={t.canShipEither} tone="text-green-600" />
        <Kpi label="Partial" value={t.partial} tone="text-amber-600" />
        <Kpi label="Blocked" value={t.blocked} tone="text-red-600" />
      </div>

      <div className="stats-grid">
        <Kpi label="Units waiting" value={t.units} />
        <Kpi label="Fully coverable from Gallatin" value={t.canShipGallatin} />
        <Kpi label="Fully coverable from Utah" value={t.canShipUtah} />
        <Kpi label="Longest waiting" value={`${t.longestWaitDays}d`} tone={t.longestWaitDays > 14 ? "text-red-600" : ""} />
      </div>

      <p className="text-xs text-gray-500 mb-4">
        Beast Broadhead {num(t.beastOrders)} order(s) · Bowmar Archery {num(t.archeryOrders)} order(s) ·
        counted from Shopify's fulfillable quantity, so removed and already-shipped units are excluded ·
        as of {new Date(view.generatedAt).toLocaleString()}
      </p>

      <div className="flex gap-2 mb-4 border-b border-gray-200 flex-wrap">
        <button onClick={() => setTab("orders")} className={`px-4 py-2 font-medium border-b-2 ${tab === "orders" ? "border-beast-600 text-beast-700" : "border-transparent text-gray-500"}`}>
          By order
        </button>
        <button onClick={() => setTab("skus")} className={`px-4 py-2 font-medium border-b-2 ${tab === "skus" ? "border-beast-600 text-beast-700" : "border-transparent text-gray-500"}`}>
          By SKU
        </button>
      </div>

      <div className="card mb-4">
        <div className="card-body !py-3 flex flex-wrap items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search order, customer, or SKU…"
            className="form-input flex-1 min-w-[200px]"
          />
          {tab === "orders" && (
            <>
              {(["all", "FULL", "PARTIAL", "NONE"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`btn btn-sm ${filter === f ? "btn-primary" : "btn-secondary"}`}
                >
                  {f === "all" ? "All" : STATUS_LABEL[f]}
                </button>
              ))}
              <span className="w-px h-6 bg-gray-200 mx-1" />
              {(["all", "beast", "archery"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setStore(s)}
                  className={`btn btn-sm ${store === s ? "btn-primary" : "btn-secondary"}`}
                >
                  {s === "all" ? "Both stores" : s === "beast" ? "Beast" : "Archery"}
                </button>
              ))}
              <span className="w-px h-6 bg-gray-200 mx-1" />
              <button
                onClick={() => setSort(sort === "waiting_desc" ? "waiting_asc" : "waiting_desc")}
                className="btn btn-secondary btn-sm"
              >
                {sort === "waiting_desc" ? "Longest waiting ↓" : "Shortest waiting ↑"}
              </button>
            </>
          )}
        </div>
      </div>

      {tab === "orders" ? (
        <div className="card">
          <div className="card-body">
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th></th><th>Order</th><th>Store</th><th>Customer</th><th>Waiting</th>
                    <th>Needed</th><th>From Gallatin</th><th>From Utah</th><th>Short</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.length === 0 && (
                    <tr><td colSpan={10} className="text-center text-gray-500 py-6">No matching orders.</td></tr>
                  )}
                  {orders.map((o) => {
                    const key = `${o.store}:${o.orderId}`;
                    const short = o.totalNeeded - o.bestFulfillable;
                    return [
                      <tr
                        key={key}
                        onClick={() => setOpen(open === key ? null : key)}
                        className="cursor-pointer"
                      >
                        <td className="text-gray-400">{open === key ? "▾" : "▸"}</td>
                        <td className="font-medium">{o.orderName}</td>
                        <td>
                          <span className={`badge ${o.store === "beast" ? "badge-purple" : "badge-blue"}`}>
                            {o.store === "beast" ? "Beast" : "Archery"}
                          </span>
                        </td>
                        <td>{o.company || o.customerName || "—"}</td>
                        <td className={o.ageDays > 14 ? "text-red-600 font-medium" : ""}>{o.ageDays}d</td>
                        <td>{num(o.totalNeeded)}</td>
                        <td className={o.gallatinStatus === "FULL" ? "text-green-700" : ""}>
                          {num(o.gallatinFulfillable)} / {num(o.totalNeeded)}
                        </td>
                        <td className={o.utahStatus === "FULL" ? "text-green-700" : ""}>
                          {num(o.utahFulfillable)} / {num(o.totalNeeded)}
                        </td>
                        <td className={short > 0 ? "text-red-600" : "text-gray-400"}>{short > 0 ? num(short) : "—"}</td>
                        <td><span className={`badge ${STATUS_CLASS[o.status]}`}>{STATUS_LABEL[o.status]}</span></td>
                      </tr>,
                      open === key && (
                        <tr key={`${key}-exp`}>
                          <td></td>
                          <td colSpan={9} className="bg-gray-50">
                            <div className="overflow-x-auto py-2">
                              <table className="data-table text-sm">
                                <thead>
                                  <tr><th>SKU</th><th>Product</th><th>Needed</th><th>Gallatin on hand</th><th>Gallatin can ship</th><th>Utah on hand</th><th>Utah can ship</th></tr>
                                </thead>
                                <tbody>
                                  {o.lines.map((l, i) => (
                                    <tr key={i}>
                                      <td className="font-mono text-xs">
                                        {l.sku}
                                        {!l.known && <span className="badge badge-red ml-2">not in inventory</span>}
                                      </td>
                                      <td>{l.title}</td>
                                      <td>{num(l.needed)}</td>
                                      <td>{l.gallatinOnHand ?? "—"}</td>
                                      <td>{num(l.gallatinFulfillable)}</td>
                                      <td>{l.utahOnHand ?? "—"}</td>
                                      <td>{num(l.utahFulfillable)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      ),
                    ];
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="card-body">
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>SKU</th><th>Product</th><th>Beast</th><th>Archery</th><th>Total</th>
                    <th>Gallatin on hand</th><th>Gallatin can ship</th><th>Utah on hand</th><th>Utah can ship</th>
                    <th>Orders</th><th>Oldest</th>
                  </tr>
                </thead>
                <tbody>
                  {skus.length === 0 && (
                    <tr><td colSpan={11} className="text-center text-gray-500 py-6">No matching SKUs.</td></tr>
                  )}
                  {skus.map((r) => {
                    const short = r.totalUnits - Math.max(r.gallatinFulfillable, r.utahFulfillable);
                    return (
                      <tr key={r.sku}>
                        <td className="font-mono text-xs">
                          {r.sku}
                          {!r.known && <span className="badge badge-red ml-2">not in inventory</span>}
                        </td>
                        <td>{r.title}</td>
                        <td>{num(r.beastUnits)}</td>
                        <td>{num(r.archeryUnits)}</td>
                        <td className={short > 0 ? "font-medium text-red-600" : "font-medium"}>{num(r.totalUnits)}</td>
                        <td>{r.gallatinOnHand ?? "—"}</td>
                        <td>{num(r.gallatinFulfillable)}</td>
                        <td>{r.utahOnHand ?? "—"}</td>
                        <td>{num(r.utahFulfillable)}</td>
                        <td>{num(r.orderCount)}</td>
                        <td className={r.oldestAgeDays > 14 ? "text-red-600" : ""}>{r.oldestAgeDays}d</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}
