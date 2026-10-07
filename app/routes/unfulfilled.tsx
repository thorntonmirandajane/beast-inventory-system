import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation, Link } from "react-router";
import { useMemo, useState } from "react";
import { requireUser, requireRole } from "../utils/auth.server";
import prisma from "../db.server";
import { clearSkuMapCache } from "../utils/sku-mapping.server";
import { Layout } from "../components/Layout";
import {
  loadUnfulfilledView,
  type UnfulfilledViewOrder,
  type ShipStatus,
} from "../utils/unfulfilled-view.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const [view, skuOptions, rules] = await Promise.all([
    loadUnfulfilledView(),
    prisma.sku.findMany({ where: { isActive: true }, select: { sku: true, name: true }, orderBy: { sku: "asc" } }),
    prisma.fulfillmentSkuMap.findMany({ orderBy: { shopifySku: "asc" } }),
  ]);
  return { user, view, skuOptions, rules };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN", "MANAGER"]);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  if (intent === "refresh") {
    await loadUnfulfilledView({ force: true });
    return { success: true, message: "Refreshed from Shopify and ShipHero." };
  }

  // Mappings are only ever created here, by hand. Nothing is inferred.
  if (intent === "map" || intent === "ignore") {
    const shopifySku = String(form.get("shopifySku") || "").trim();
    if (!shopifySku) return { error: "No SKU given." };
    const inventorySku = String(form.get("inventorySku") || "").trim();
    if (intent === "map" && !inventorySku) {
      return { error: `Pick the inventory SKU that "${shopifySku}" means.` };
    }
    await prisma.fulfillmentSkuMap.upsert({
      where: { shopifySku },
      create: {
        shopifySku,
        inventorySku: intent === "map" ? inventorySku : null,
        ignore: intent === "ignore",
        note: String(form.get("note") || "").trim() || null,
        createdById: user.id,
      },
      update: {
        inventorySku: intent === "map" ? inventorySku : null,
        ignore: intent === "ignore",
        note: String(form.get("note") || "").trim() || null,
      },
    });
    clearSkuMapCache();
    await loadUnfulfilledView({ force: true });
    return {
      success: true,
      message: intent === "map" ? `${shopifySku} now counts as ${inventorySku}.` : `${shopifySku} will be left out.`,
    };
  }

  if (intent === "unmap") {
    const shopifySku = String(form.get("shopifySku") || "").trim();
    if (shopifySku) await prisma.fulfillmentSkuMap.delete({ where: { shopifySku } }).catch(() => {});
    clearSkuMapCache();
    await loadUnfulfilledView({ force: true });
    return { success: true, message: `Rule for ${shopifySku} removed.` };
  }

  return { error: "Unknown action." };
};

const num = (n: number) => n.toLocaleString();
const money = (n: number) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
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
  const { user, view, skuOptions, rules } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";

  const [tab, setTab] = useState<"orders" | "skus">("orders");
  const [filter, setFilter] = useState<"all" | ShipStatus>("all");
  // Which warehouse the can-ship / partial / blocked filter is asking about.
  const [scope, setScope] = useState<"either" | "gallatin" | "utah">("either");
  const [sort, setSort] = useState<"waiting_desc" | "waiting_asc">("waiting_desc");
  const [store, setStore] = useState<"all" | "beast" | "archery">("all");
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const orders = useMemo(() => {
    let rows = view.orders as UnfulfilledViewOrder[];
    if (filter !== "all") {
      rows = rows.filter((o) =>
        (scope === "gallatin" ? o.gallatinStatus : scope === "utah" ? o.utahStatus : o.status) === filter
      );
    }
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
  }, [view.orders, filter, scope, store, sort, q]);

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
          <Link to="/fulfillment-plans" className="btn btn-primary btn-sm">Game plans</Link>
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
        <Kpi label="Longest waiting" value={`${t.longestWaitDays}d`} tone={t.longestWaitDays > 14 ? "text-red-600" : ""} />
        <Kpi label="Can ship (either site)" value={t.canShipEither} tone="text-green-600" />
        <Kpi label="Partial" value={t.partial} tone="text-amber-600" />
        <Kpi label="Blocked" value={t.blocked} tone="text-red-600" />
      </div>

      <div className="stats-grid">
        <Kpi label="Units waiting" value={t.units} />
        <Kpi label="Value waiting" value={money(t.value)} />
        <Kpi label="Fully coverable from Gallatin" value={t.canShipGallatin} />
        <Kpi label="Fully coverable from Utah" value={t.canShipUtah} />
      </div>

      {/* Shopify SKUs with no inventory match. These still COUNT — Gallatin
          stocks plenty we don't manufacture — they just have no Utah stock. */}
      {view.unmapped.length > 0 && (
        <details className="card mb-4">
          <summary className="card-header cursor-pointer select-none">
            <span className="card-title text-base">
              {view.unmapped.length} Shopify SKU{view.unmapped.length === 1 ? "" : "s"} with no inventory match
            </span>
            <span className="text-xs text-gray-500">
              counted as demand · {num(view.unmapped.reduce((t, r) => t + r.units, 0))} units
            </span>
          </summary>
          <div className="card-body">
            <div className="alert alert-info mb-3 text-sm">
              These are still counted. Beast Inventory only tracks what's made here, and Gallatin stocks a lot more
              that ships perfectly well — all a missing mapping means is there's no Utah stock to check against.
              Map one only if it's something you make under a different code, or ignore it if it should never be picked.
            </div>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>Shopify SKU</th><th>Units</th><th>Orders</th><th>What should happen</th></tr></thead>
                <tbody>
                  {view.unmapped.map((r) => (
                    <tr key={r.shopifySku}>
                      <td className="font-mono text-xs">{r.shopifySku}</td>
                      <td>{num(r.units)}</td>
                      <td>{num(r.orders)}</td>
                      <td>
                        <Form method="post" className="flex flex-wrap items-center gap-2">
                          <input type="hidden" name="shopifySku" value={r.shopifySku} />
                          <select name="inventorySku" className="form-select" style={{ maxWidth: 260 }} defaultValue="">
                            <option value="">— choose an inventory SKU —</option>
                            {skuOptions.map((o) => (
                              <option key={o.sku} value={o.sku}>{o.sku} — {o.name}</option>
                            ))}
                          </select>
                          <button name="intent" value="map" className="btn btn-secondary btn-sm" disabled={busy}>Map</button>
                          <button name="intent" value="ignore" className="btn btn-secondary btn-sm text-red-600" disabled={busy}>Ignore</button>
                        </Form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </details>
      )}

      {/* Lines deliberately left out. */}
      {view.skipped.length > 0 && (
        <details className="card mb-4">
          <summary className="card-header cursor-pointer select-none">
            <span className="card-title text-base">
              {view.skipped.length} SKU{view.skipped.length === 1 ? "" : "s"} left out of these numbers
            </span>
            <span className="text-xs text-gray-500">{num(view.skipped.reduce((t, r) => t + r.units, 0))} units</span>
          </summary>
          <div className="card-body">
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>Shopify SKU</th><th>Why</th><th>Units</th><th>Orders</th><th></th></tr></thead>
                <tbody>
                  {view.skipped.map((r) => (
                    <tr key={`${r.reason}-${r.shopifySku}`}>
                      <td className="font-mono text-xs">{r.shopifySku}</td>
                      <td>
                        {r.reason === "ORDER_DEFENSE" ? (
                          <span className="badge badge-gray">Order Defense — digital, never picked</span>
                        ) : (
                          <span className="badge badge-blue">Ignored{r.note ? ` — ${r.note}` : ""}</span>
                        )}
                      </td>
                      <td>{num(r.units)}</td>
                      <td>{num(r.orders)}</td>
                      <td>
                        {r.reason === "IGNORED" && (
                          <Form method="post">
                            <input type="hidden" name="intent" value="unmap" />
                            <input type="hidden" name="shopifySku" value={r.shopifySku} />
                            <button className="btn btn-secondary btn-sm" disabled={busy}>Start counting it</button>
                          </Form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </details>
      )}

      {/* Rules someone has entered, and where they apply. */}
      <details className="card mb-4">
        <summary className="card-header cursor-pointer select-none">
          <span className="card-title text-base">SKU rules for the fulfillment views</span>
          <span className="text-xs text-gray-500">
            {num(view.mapping.mapped)} mapped · {num(view.mapping.ignored)} ignored · {num(view.mapping.remappedLines)} line(s) remapped
          </span>
        </summary>
        <div className="card-body">
          <div className="alert alert-warning mb-3 text-sm">
            <strong>These rules apply to Unfulfilled, Game plans and Compare plans only.</strong> Backorder and Build
            Plan keep their own SKU mappings and exclusions, managed on the Backorder page — nothing entered here
            changes those numbers.
          </div>
          {rules.length === 0 ? (
            <p className="text-sm text-gray-500">No rules yet. Everything is counted exactly as Shopify sends it.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>Shopify SKU</th><th>Treated as</th><th>Note</th><th></th></tr></thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.shopifySku}>
                      <td className="font-mono text-xs">{r.shopifySku}</td>
                      <td>
                        {r.ignore
                          ? <span className="badge badge-red">Left out</span>
                          : <span className="font-mono text-xs">{r.inventorySku}</span>}
                      </td>
                      <td className="text-xs text-gray-500">{r.note || "—"}</td>
                      <td>
                        <Form method="post">
                          <input type="hidden" name="intent" value="unmap" />
                          <input type="hidden" name="shopifySku" value={r.shopifySku} />
                          <button className="btn btn-secondary btn-sm" disabled={busy}>Remove</button>
                        </Form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </details>

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
              {/* Which warehouse the status above is asking about. Always shown,
                  so "what can Gallatin ship" is one click rather than a mode you
                  have to discover. */}
              <span className="text-xs text-gray-500">from</span>
              {([
                ["either", "Either site"],
                ["gallatin", "Gallatin"],
                ["utah", "Utah"],
              ] as const).map(([v, label]) => (
                <button
                  key={v}
                  onClick={() => setScope(v)}
                  disabled={filter === "all"}
                  title={filter === "all" ? "Pick Can ship, Partial or Blocked first" : undefined}
                  className={`btn btn-sm ${scope === v ? "btn-primary" : "btn-secondary"} ${filter === "all" ? "opacity-50" : ""}`}
                >
                  {label}
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
                    <th>Needed</th><th>Value</th><th>From Gallatin</th><th>From Utah</th><th>Short</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.length === 0 && (
                    <tr><td colSpan={11} className="text-center text-gray-500 py-6">No matching orders.</td></tr>
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
                        <td className="tabular-nums">{money(o.unfulfilledValue)}</td>
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
                          <td colSpan={10} className="bg-gray-50">
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
                                        {l.shopifySku && (
                                          <span className="block text-[11px] text-gray-400">Shopify: {l.shopifySku}</span>
                                        )}
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
                    <th>SKU</th><th>Product</th><th>Beast</th><th>Archery</th><th>Total</th><th>Value</th>
                    <th>Gallatin on hand</th><th>Gallatin can ship</th><th>Utah on hand</th><th>Utah can ship</th>
                    <th>Orders</th><th>Oldest</th>
                  </tr>
                </thead>
                <tbody>
                  {skus.length === 0 && (
                    <tr><td colSpan={12} className="text-center text-gray-500 py-6">No matching SKUs.</td></tr>
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
                        <td className="tabular-nums">{money(r.totalValue)}</td>
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
