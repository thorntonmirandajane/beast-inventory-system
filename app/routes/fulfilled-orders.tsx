import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Form, useNavigation, Link, useFetcher } from "react-router";
import { useEffect, useState } from "react";
import { requireRole } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import {
  getFulfilledInRange,
  aggregateFulfilled,
  isShopifySyncing,
  type FulfilledReport,
} from "../utils/shopify.server";

// A completed SKU fulfilled in-house (Utah) that we can pre-fill into a transfer.
interface TransferCandidate {
  skuId: string;
  sku: string;
  name: string;
  utah: number; // units fulfilled in-house in the range (the pre-filled quantity)
  available: number; // completed on-hand at Gallatin, the transfer ceiling
}

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

  // Build the "Create Transfer" candidates: SKUs fulfilled in-house (Utah) that
  // map to an active COMPLETED product with on-hand stock at Gallatin. Same
  // eligibility rule the Transfers tab uses, so the /transfers action accepts them.
  let transferCandidates: TransferCandidate[] = [];
  let ineligibleCount = 0;
  if (report) {
    const utahRows = report.bySku.filter((r) => r.utah > 0);
    const skuStrings = utahRows.map((r) => r.sku);
    const dbSkus = skuStrings.length
      ? await prisma.sku.findMany({
          where: { sku: { in: skuStrings }, isActive: true, type: "COMPLETED" },
          include: {
            inventoryItems: { where: { state: "COMPLETED", quantity: { gt: 0 } } },
          },
        })
      : [];
    // Map SKU string -> best match (prefer the record with the most on-hand, in
    // case a SKU string is duplicated across products).
    const bySkuString = new Map<string, { id: string; name: string; available: number }>();
    for (const s of dbSkus) {
      const available = s.inventoryItems.reduce((a, it) => a + it.quantity, 0);
      const existing = bySkuString.get(s.sku);
      if (!existing || available > existing.available) {
        bySkuString.set(s.sku, { id: s.id, name: s.name, available });
      }
    }
    for (const r of utahRows) {
      const match = bySkuString.get(r.sku);
      if (match && match.available > 0) {
        transferCandidates.push({
          skuId: match.id,
          sku: r.sku,
          name: match.name,
          utah: r.utah,
          available: match.available,
        });
      } else {
        ineligibleCount++; // not a stocked completed product — can't be transferred
      }
    }
  }

  return {
    user,
    report,
    error,
    from,
    to,
    syncing: isShopifySyncing(),
    transferCandidates,
    ineligibleCount,
  };
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
  const { user, report, error, from, to, syncing, transferCandidates, ineligibleCount } =
    useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";

  // "Create Transfer" — confirm-before-submit modal that posts the same
  // intent=create form the Transfers tab uses, straight to the /transfers action.
  const transfer = useFetcher<{ success?: boolean; message?: string; error?: string }>();
  const [showTransfer, setShowTransfer] = useState(false);
  const transferring = transfer.state !== "idle";
  const transferDone = transfer.data?.success && transfer.state === "idle";
  // Close the modal once the transfer succeeds.
  useEffect(() => {
    if (transferDone) setShowTransfer(false);
  }, [transferDone]);

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

  // Pre-filled transfer quantities: the Utah units, capped at Gallatin on-hand.
  const transferDefaults = transferCandidates.map((c) => ({
    ...c,
    qty: Math.min(c.utah, c.available),
  }));
  const totalTransferUnits = transferDefaults.reduce((s, c) => s + c.qty, 0);

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

      {transfer.data?.success && (
        <div className="alert alert-success mb-4">
          {transfer.data.message}{" "}
          <Link to="/transfers" className="underline">View transfers</Link>
        </div>
      )}
      {transfer.data?.error && (
        <div className="alert alert-error mb-4">Transfer failed: {transfer.data.error}</div>
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

          {/* Create Transfer — pre-fills the in-house (Utah) fulfilled quantities */}
          <div className="card mb-6">
            <div className="card-header">
              <h2 className="card-title">Create Transfer</h2>
            </div>
            <div className="card-body">
              {transferDefaults.length > 0 ? (
                <>
                  <p className="text-sm text-gray-600 mb-3">
                    Pre-fills a transfer with the {transferDefaults.length} completed SKU
                    {transferDefaults.length === 1 ? "" : "s"} fulfilled in-house (Utah) in this
                    range — {num(totalTransferUnits)} unit{totalTransferUnits === 1 ? "" : "s"}. You'll
                    confirm everything before it's submitted.
                  </p>
                  <button className="btn btn-primary" onClick={() => setShowTransfer(true)}>
                    Create Transfer
                  </button>
                  {ineligibleCount > 0 && (
                    <p className="text-xs text-gray-500 mt-2">
                      {ineligibleCount} Utah-fulfilled SKU{ineligibleCount === 1 ? "" : "s"} aren't
                      stocked completed products and were left out.
                    </p>
                  )}
                </>
              ) : (
                <p className="text-sm text-gray-500">
                  No in-house (Utah) fulfillments in this range map to stocked completed products,
                  so there's nothing to transfer.
                </p>
              )}
            </div>
          </div>
        </>
      )}

      {/* Confirmation modal — reviews everything, then posts the same intent=create
          form the Transfers tab uses straight to the /transfers action. */}
      {showTransfer && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => !transferring && setShowTransfer(false)}
        >
          <div
            className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <transfer.Form method="post" action="/transfers" className="p-6">
              <input type="hidden" name="intent" value="create" />
              <h2 className="text-lg font-bold mb-1">Confirm Transfer</h2>
              <p className="text-sm text-gray-500 mb-4">
                Review the details below. This deducts the quantities from Gallatin completed
                inventory when submitted.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                <div className="form-group mb-0">
                  <label className="form-label">Destination *</label>
                  <input
                    type="text"
                    name="destination"
                    className="form-input"
                    required
                    defaultValue="Fulfilled Orders"
                  />
                </div>
                <div className="form-group mb-0">
                  <label className="form-label">Transfer Date</label>
                  <input
                    type="date"
                    name="transferDate"
                    className="form-input"
                    defaultValue={mountainToday()}
                  />
                </div>
                <div className="form-group mb-0">
                  <label className="form-label">Notes</label>
                  <input
                    type="text"
                    name="notes"
                    className="form-input"
                    defaultValue={`In-house (Utah) fulfillments ${
                      from === to ? from : `${from} to ${to}`
                    }`}
                  />
                </div>
              </div>

              <div className="overflow-x-auto mb-4">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Name</th>
                      <th className="text-right">Utah fulfilled</th>
                      <th className="text-right">Available</th>
                      <th className="w-28 text-right">Quantity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transferDefaults.map((c, i) => (
                      <tr key={c.skuId}>
                        <td className="font-mono text-sm">
                          <input type="hidden" name={`items[${i}][skuId]`} value={c.skuId} />
                          {c.sku}
                        </td>
                        <td className="text-sm max-w-xs truncate">{c.name}</td>
                        <td className="text-right text-sm">{num(c.utah)}</td>
                        <td className="text-right text-sm text-green-600">{num(c.available)}</td>
                        <td className="text-right">
                          <input
                            type="number"
                            name={`items[${i}][quantity]`}
                            className="form-input w-24 text-right"
                            min={0}
                            max={c.available}
                            defaultValue={c.qty}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {transferDefaults.some((c) => c.available < c.utah) && (
                <p className="text-xs text-amber-600 mb-4">
                  Some SKUs have less on-hand at Gallatin than was fulfilled in-house, so their
                  quantity was capped at what's available. Adjust as needed.
                </p>
              )}

              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowTransfer(false)}
                  disabled={transferring}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={transferring}>
                  {transferring ? "Creating…" : "Confirm & Create Transfer"}
                </button>
              </div>
            </transfer.Form>
          </div>
        </div>
      )}
    </Layout>
  );
}
