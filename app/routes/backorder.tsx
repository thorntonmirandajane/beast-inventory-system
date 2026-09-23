import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import { useMemo, useState } from "react";
import { requireUser, requireRole, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import {
  loadBackorderView,
  seedBackorderMappings,
  type BackorderSnapshot,
} from "../utils/backorder.server";

const isManager = (role: string) => role === "ADMIN" || role === "MANAGER";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // ETA lookup is usable by anyone signed in; admin panels are gated in the UI.
  const user = await requireUser(request);
  const view = await loadBackorderView();

  const [aliases, exclusions, skuOptions] = await Promise.all([
    prisma.skuAlias.findMany({ orderBy: { alias: "asc" } }),
    prisma.backorderExclusion.findMany({ orderBy: { sku: "asc" } }),
    prisma.sku.findMany({
      where: { isActive: true },
      select: { id: true, sku: true, name: true, type: true },
      orderBy: { sku: "asc" },
    }),
  ]);
  const skuNameById = new Map(skuOptions.map((s) => [s.id, s.sku]));
  const mappings = aliases.map((a) => ({
    id: a.id,
    alias: a.alias,
    isPattern: a.isPattern,
    target: a.isPattern ? (a.replacement ?? "") : (a.skuId ? (skuNameById.get(a.skuId) ?? "(missing SKU)") : "(missing SKU)"),
  }));

  return { user, view, mappings, exclusions, skuOptions };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN", "MANAGER"]);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  if (intent === "run-now") {
    await loadBackorderView({ force: true });
    await createAuditLog(user.id, "RUN_BACKORDER", "BackorderRun", "singleton", {});
    return { success: true, message: "Backorder run complete." };
  }

  if (intent === "seed-mappings") {
    await seedBackorderMappings();
    return { success: true, message: "Seeded the known SKU mappings." };
  }

  if (intent === "add-mapping") {
    const alias = String(form.get("alias") || "").trim();
    const isPattern = String(form.get("isPattern") || "") === "on";
    if (!alias) return { error: "Shopify SKU or pattern is required." };
    const exists = await prisma.skuAlias.findUnique({ where: { alias } });
    if (exists) return { error: `A mapping for "${alias}" already exists.` };
    if (isPattern) {
      const replacement = String(form.get("replacement") || "").trim();
      if (!replacement) return { error: "A replacement template (e.g. TRUMP-*) is required for pattern rules." };
      await prisma.skuAlias.create({ data: { alias, isPattern: true, replacement } });
      await createAuditLog(user.id, "ADD_SKU_MAPPING", "SkuAlias", alias, { replacement, isPattern: true });
      return { success: true, message: `Added pattern ${alias} → ${replacement}.` };
    }
    const skuId = String(form.get("skuId") || "");
    if (!skuId) return { error: "Target inventory SKU is required." };
    await prisma.skuAlias.create({ data: { alias, skuId, isPattern: false } });
    await createAuditLog(user.id, "ADD_SKU_MAPPING", "SkuAlias", alias, { skuId, isPattern: false });
    return { success: true, message: `Mapped ${alias} → inventory SKU.` };
  }

  if (intent === "delete-mapping") {
    const id = String(form.get("id") || "");
    if (id) await prisma.skuAlias.delete({ where: { id } }).catch(() => {});
    return { success: true, message: "Mapping removed." };
  }

  if (intent === "add-exclusion") {
    const sku = String(form.get("sku") || "").trim();
    const reason = String(form.get("reason") || "").trim() || null;
    if (!sku) return { error: "SKU is required." };
    const exists = await prisma.backorderExclusion.findUnique({ where: { sku } });
    if (exists) return { error: `"${sku}" is already excluded.` };
    await prisma.backorderExclusion.create({ data: { sku, reason } });
    await createAuditLog(user.id, "ADD_BACKORDER_EXCLUSION", "BackorderExclusion", sku, { reason });
    return { success: true, message: `Excluded ${sku}.` };
  }

  if (intent === "delete-exclusion") {
    const id = String(form.get("id") || "");
    if (id) await prisma.backorderExclusion.delete({ where: { id } }).catch(() => {});
    return { success: true, message: "Exclusion removed." };
  }

  if (intent === "update-config") {
    const n = parseInt(String(form.get("etaBusinessDays") || "4"), 10);
    const etaBusinessDays = Number.isFinite(n) && n >= 0 && n <= 60 ? n : 4;
    await prisma.backorderConfig.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", etaBusinessDays },
      update: { etaBusinessDays },
    });
    return { success: true, message: `ETA buffer set to ${etaBusinessDays} business days.` };
  }

  return { error: "Unknown action." };
};

// ---- small helpers ----
const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString() : "—";
const fmtDateTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString() : "—";
const num = (n: number) => n.toLocaleString();

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// Client-side blob download so a click never navigates.
function downloadFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function Backorder() {
  const { user, view, mappings, exclusions, skuOptions } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const snap = view.snapshot as BackorderSnapshot | null;
  const manager = isManager(user.role);

  const [etaQuery, setEtaQuery] = useState("");
  const [capacity, setCapacity] = useState("");

  const today = new Date().toISOString().split("T")[0];

  // ---- Tag list CSV (Matrixify-compatible: Name + Tags Command + Tags) ----
  const downloadTagCsv = () => {
    if (!snap) return;
    const rows = [["Name", "Store", "Customer", "Tags Command", "Tags", "STG Ships"]];
    for (const t of snap.tagList) {
      const skuStr = t.ships.map((s) => `${s.invSku} x${s.qty}`).join("; ");
      rows.push([
        t.orderName,
        t.store,
        t.customer,
        "ADD",
        t.tagsToApply.join(", "),
        skuStr,
      ]);
    }
    const csv = rows.map((r) => r.map((c) => csvEscape(String(c))).join(",")).join("\n");
    downloadFile(`stg-tags-${today}.csv`, "﻿" + csv, "text/csv;charset=utf-8");
  };

  // ---- Explanation sheet (printable text) ----
  const explanationText = useMemo(() => {
    if (!snap) return "";
    const lines: string[] = [];
    lines.push(`STG Fulfillment Instructions — ${new Date(snap.generatedAt).toLocaleString()}`);
    lines.push(snap.backorder ? "STATUS: BACKORDERED" : "STATUS: No backorder");
    lines.push("");
    if (snap.tagList.length === 0) {
      lines.push("No orders for STG to ship today.");
    } else {
      lines.push(`Ship the following ${snap.tagList.length} order(s) from STG:`);
      lines.push("");
      for (const t of snap.tagList) {
        lines.push(`Order ${t.orderName} (${t.store}) — ${t.customer}`);
        for (const s of t.ships) lines.push(`   • Pull ${s.qty} × ${s.invSku}  [Shopify SKU ${s.shopifySku}]`);
        lines.push(`   Tags to add: ${t.tagsToApply.join(", ")}`);
        lines.push(
          t.partial
            ? "   NOTE: PARTIAL — STG ships only the SKUs listed above; the rest is short/backordered."
            : "   This order ships COMPLETE from STG."
        );
        lines.push("");
      }
    }
    return lines.join("\n");
  }, [snap]);

  const downloadExplanation = () =>
    downloadFile(`stg-instructions-${today}.txt`, explanationText, "text/plain;charset=utf-8");

  // ---- ETA search ----
  const etaResults = useMemo(() => {
    if (!snap) return [];
    const q = etaQuery.trim().toLowerCase();
    if (!q) return snap.etas.slice(0, 50);
    return snap.etas.filter(
      (e) =>
        e.orderName.toLowerCase().includes(q) ||
        e.who.toLowerCase().includes(q) ||
        (e.email ?? "").toLowerCase().includes(q) ||
        e.invSku.toLowerCase().includes(q) ||
        e.shopifySku.toLowerCase().includes(q)
    );
  }, [snap, etaQuery]);

  // ---- Production planning: capacity cap over build recommendations ----
  const buildRecs = useMemo(() => {
    if (!snap) return [];
    const cap = parseInt(capacity, 10);
    const rows = snap.buildPlan.rows
      .filter((r) => r.built > 0 || r.short > 0)
      .map((r) => ({ sku: r.sku, name: r.name, recommend: r.built, short: r.short, binding: r.bindingSku }));
    if (!Number.isFinite(cap) || cap <= 0) return rows;
    let left = cap;
    return rows.map((r) => {
      const take = Math.min(r.recommend, left);
      left -= take;
      return { ...r, recommend: take };
    });
  }, [snap, capacity]);

  return (
    <Layout user={user}>
      <div className="page-header flex justify-between items-start">
        <div>
          <h1 className="page-title">Backorder Allocation</h1>
          <p className="page-subtitle">
            STG fulfillment planning · last run {fmtDateTime(view.ranAt)}
          </p>
        </div>
        {manager && (
          <Form method="post">
            <input type="hidden" name="intent" value="run-now" />
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Running…" : "Run now"}
            </button>
          </Form>
        )}
      </div>

      {actionData?.error && <div className="alert alert-error">{actionData.error}</div>}
      {actionData?.success && <div className="alert alert-success">{actionData.message}</div>}

      {!snap && (
        <div className="card"><div className="card-body">No run yet. Click “Run now”.</div></div>
      )}

      {snap && (
        <>
          {/* Status banner */}
          <div className={`alert ${snap.backorder ? "alert-error" : "alert-success"} mb-4`}>
            <strong>{snap.backorder ? "BACKORDERED" : "No backorder"}</strong>
            {snap.backorder
              ? " — open demand exceeds completed stock at STG + Gallatin for one or more build-plan SKUs."
              : " — completed stock covers current demand. Allocation outputs are hidden; production planning is still available below."}
          </div>

          {manager && (
            <>
          {/* Data health */}
          {snap.exceptions.dataProblems.length > 0 && (
            <div className="alert alert-warning mb-4">
              <strong>Data warnings:</strong>
              <ul className="list-disc ml-6 mt-1">
                {snap.exceptions.dataProblems.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            </div>
          )}

          {/* ===== Allocation outputs (only when backordered) ===== */}
          {snap.backorder && (
            <>
              {/* 1. STG Fulfillment Tag List */}
              <section className="card mb-6">
                <div className="card-header flex justify-between items-center">
                  <h2 className="card-title">STG Fulfillment Tag List ({snap.tagList.length})</h2>
                  <div className="flex gap-2">
                    <button className="btn btn-secondary btn-sm" onClick={downloadTagCsv}>Download CSV (Matrixify)</button>
                  </div>
                </div>
                <div className="card-body overflow-x-auto">
                  {snap.tagList.length === 0 ? (
                    <p className="text-gray-500">Nothing for STG to ship.</p>
                  ) : (
                    <table className="data-table">
                      <thead>
                        <tr><th>Order</th><th>Store</th><th>Customer</th><th>Tags to apply</th><th>STG ships</th></tr>
                      </thead>
                      <tbody>
                        {snap.tagList.map((t) => (
                          <tr key={`${t.store}-${t.orderName}`}>
                            <td className="font-mono">{t.orderName}</td>
                            <td>{t.store}</td>
                            <td>{t.customer}</td>
                            <td>
                              {t.tagsToApply.map((tag) => (
                                <span key={tag} className={`badge mr-1 ${tag === "STGFULL" ? "bg-green-100 text-green-800" : tag === "STGPART" ? "bg-orange-100 text-orange-800" : "bg-gray-100 text-gray-700"}`}>{tag}</span>
                              ))}
                            </td>
                            <td>{t.ships.map((s) => `${s.invSku} ×${s.qty}`).join(", ")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </section>

              {/* 2. Explanation sheet */}
              <section className="card mb-6">
                <div className="card-header flex justify-between items-center">
                  <h2 className="card-title">STG Explanation Sheet</h2>
                  <div className="flex gap-2">
                    <button className="btn btn-secondary btn-sm" onClick={() => window.print()}>Print</button>
                    <button className="btn btn-secondary btn-sm" onClick={downloadExplanation}>Download .txt</button>
                  </div>
                </div>
                <div className="card-body">
                  <pre className="whitespace-pre-wrap text-sm bg-gray-50 p-4 rounded border">{explanationText}</pre>
                </div>
              </section>

              {/* 4. Shortfall by order */}
              <section className="card mb-6">
                <div className="card-header"><h2 className="card-title">Shortfall by Order ({snap.shortfallByOrder.length})</h2></div>
                <div className="card-body overflow-x-auto">
                  {snap.shortfallByOrder.length === 0 ? (
                    <p className="text-gray-500">No order-level shortfalls.</p>
                  ) : (
                    <table className="data-table">
                      <thead><tr><th>Order</th><th>Store</th><th>Company / Customer</th><th>Email</th><th>SKU</th><th className="text-right">Qty short</th><th>Order date</th></tr></thead>
                      <tbody>
                        {snap.shortfallByOrder.map((r, i) => (
                          <tr key={i}>
                            <td className="font-mono">{r.orderName}</td>
                            <td>{r.store}</td>
                            <td>{r.who}</td>
                            <td>{r.email ?? "—"}</td>
                            <td>{r.invSku}</td>
                            <td className="text-right">{num(r.qtyShort)}</td>
                            <td>{fmtDate(r.orderDate)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </section>
            </>
          )}

          {/* 3. Shortfall by SKU (always useful) */}
          <section className="card mb-6">
            <div className="card-header"><h2 className="card-title">Shortfall by SKU</h2></div>
            <div className="card-body overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>SKU</th><th>Name</th><th className="text-right">Demand</th><th className="text-right">STG</th><th className="text-right">Gallatin</th><th className="text-right">Available</th><th className="text-right">Short</th></tr></thead>
                <tbody>
                  {snap.shortfallBySku.map((r) => (
                    <tr key={r.invSku} className={r.short > 0 ? "bg-red-50" : ""}>
                      <td className="font-mono">{r.invSku}</td>
                      <td>{r.name}</td>
                      <td className="text-right">{num(r.demand)}</td>
                      <td className="text-right">{num(r.stgCompleted)}</td>
                      <td className="text-right">{num(r.gallatinCompleted)}</td>
                      <td className="text-right">{num(r.available)}</td>
                      <td className={`text-right font-semibold ${r.short > 0 ? "text-red-600" : ""}`}>{num(r.short)}</td>
                    </tr>
                  ))}
                  {snap.shortfallBySku.length === 0 && <tr><td colSpan={7} className="text-center text-gray-500 py-4">No in-scope demand.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          {/* Reconciliation */}
          <section className="card mb-6">
            <div className="card-header"><h2 className="card-title">Reconciliation (demand = Gallatin + STG + short)</h2></div>
            <div className="card-body overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>SKU</th><th className="text-right">Demand</th><th className="text-right">Gallatin</th><th className="text-right">STG</th><th className="text-right">Short</th><th>Balances</th></tr></thead>
                <tbody>
                  {snap.reconciliation.map((r) => (
                    <tr key={r.invSku}>
                      <td className="font-mono">{r.invSku}</td>
                      <td className="text-right">{num(r.demand)}</td>
                      <td className="text-right">{num(r.gallatinCovered)}</td>
                      <td className="text-right">{num(r.stgAllocated)}</td>
                      <td className="text-right">{num(r.short)}</td>
                      <td>{r.balances ? <span className="text-green-600">✓</span> : <span className="text-red-600 font-semibold">✗ off</span>}</td>
                    </tr>
                  ))}
                  {snap.reconciliation.length === 0 && <tr><td colSpan={6} className="text-center text-gray-500 py-4">Nothing to reconcile.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          {/* Exceptions */}
          <section className="card mb-6">
            <div className="card-header"><h2 className="card-title">Exceptions</h2></div>
            <div className="card-body space-y-4">
              <div>
                <h3 className="font-semibold mb-1">Unmapped Shopify SKUs ({snap.exceptions.unmapped.length})</h3>
                {snap.exceptions.unmapped.length === 0 ? <p className="text-gray-500 text-sm">None — every SKU mapped.</p> : (
                  <table className="data-table"><thead><tr><th>Shopify SKU</th><th className="text-right">Qty</th><th>Orders</th></tr></thead>
                    <tbody>{snap.exceptions.unmapped.map((u) => (
                      <tr key={u.shopifySku}><td className="font-mono">{u.shopifySku}</td><td className="text-right">{num(u.qty)}</td><td className="text-sm text-gray-600">{u.orders.join(", ")}</td></tr>
                    ))}</tbody>
                  </table>
                )}
              </div>
              <div>
                <h3 className="font-semibold mb-1">Excluded / manual SKUs ({snap.exceptions.excluded.length})</h3>
                {snap.exceptions.excluded.length === 0 ? <p className="text-gray-500 text-sm">None in current demand.</p> : (
                  <table className="data-table"><thead><tr><th>SKU</th><th>Reason</th><th className="text-right">Demand</th><th>Orders</th></tr></thead>
                    <tbody>{snap.exceptions.excluded.map((e) => (
                      <tr key={e.sku}><td className="font-mono">{e.sku}</td><td>{e.reason ?? "—"}</td><td className="text-right">{num(e.demand)}</td><td className="text-sm text-gray-600">{e.orders.join(", ")}</td></tr>
                    ))}</tbody>
                  </table>
                )}
              </div>
            </div>
          </section>

          {/* Production planning */}
          <section className="card mb-6">
            <div className="card-header flex justify-between items-center">
              <h2 className="card-title">Production Planning — What to build</h2>
              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-600">Capacity:</label>
                <input type="number" min="0" value={capacity} onChange={(e) => setCapacity(e.target.value)} placeholder="e.g. 2500" className="form-input w-32" />
              </div>
            </div>
            <div className="card-body overflow-x-auto">
              <p className="text-sm text-gray-500 mb-3">Recommended builds cover the oldest backorders first, limited by current raw materials + incoming POs{capacity ? `, capped at ${num(parseInt(capacity, 10) || 0)} units` : ""}.</p>
              <table className="data-table">
                <thead><tr><th>SKU</th><th>Name</th><th className="text-right">Build</th><th className="text-right">Still short</th><th>Gated by</th></tr></thead>
                <tbody>
                  {buildRecs.map((r) => (
                    <tr key={r.sku}>
                      <td className="font-mono">{r.sku}</td>
                      <td>{r.name}</td>
                      <td className="text-right font-semibold">{num(r.recommend)}</td>
                      <td className="text-right">{num(r.short)}</td>
                      <td>{r.binding ?? "—"}</td>
                    </tr>
                  ))}
                  {buildRecs.length === 0 && <tr><td colSpan={5} className="text-center text-gray-500 py-4">Nothing to build.</td></tr>}
                </tbody>
              </table>

              {snap.poMatches.length > 0 && (
                <div className="mt-4">
                  <h3 className="font-semibold mb-1">Incoming POs matched to components</h3>
                  <table className="data-table"><thead><tr><th>PO</th><th>Component</th><th className="text-right">Incoming</th><th>ETA</th></tr></thead>
                    <tbody>{snap.poMatches.map((p, i) => (
                      <tr key={i}><td className="font-mono">{p.poNumber}</td><td>{p.componentSku} — {p.componentName}</td><td className="text-right">{num(p.incoming)}</td><td>{fmtDate(p.eta)}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

            </>
          )}

          {/* Order ETA lookup (anyone) */}
          <section className="card mb-6">
            <div className="card-header"><h2 className="card-title">Order ETA Lookup</h2></div>
            <div className="card-body">
              <input
                type="text"
                value={etaQuery}
                onChange={(e) => setEtaQuery(e.target.value)}
                placeholder="Search order #, customer, company, email, or SKU…"
                className="form-input mb-3"
              />
              <p className="text-xs text-gray-500 mb-2">Estimated ship = date all materials are on hand (stock or matched PO ETA) + {snap.etaBusinessDays} business days.</p>
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead><tr><th>Order</th><th>Who</th><th>SKU</th><th className="text-right">Qty</th><th>Materials ready</th><th>Est. ship</th><th>Gating item</th></tr></thead>
                  <tbody>
                    {etaResults.map((e, i) => (
                      <tr key={i}>
                        <td className="font-mono">{e.orderName}</td>
                        <td>{e.who}</td>
                        <td>{e.invSku}</td>
                        <td className="text-right">{num(e.qty)}</td>
                        <td>{fmtDate(e.materialsReady)}</td>
                        <td className={e.shipDate ? "" : "text-red-600"}>{e.shipDate ? fmtDate(e.shipDate) : "No ETA"}</td>
                        <td className="text-sm">{e.gating}</td>
                      </tr>
                    ))}
                    {etaResults.length === 0 && <tr><td colSpan={7} className="text-center text-gray-500 py-4">{etaQuery ? "No matches." : "No backordered lines."}</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          {/* ===== Admin: mappings, exclusions, config ===== */}
          {manager && (
            <section className="card mb-6">
              <div className="card-header"><h2 className="card-title">Settings (admin)</h2></div>
              <div className="card-body space-y-6">
                {/* Config */}
                <div>
                  <h3 className="font-semibold mb-2">ETA buffer</h3>
                  <Form method="post" className="flex items-end gap-2">
                    <input type="hidden" name="intent" value="update-config" />
                    <div className="form-group mb-0">
                      <label className="form-label">Business days after materials on hand</label>
                      <input type="number" name="etaBusinessDays" min="0" max="60" defaultValue={snap.etaBusinessDays} className="form-input w-32" />
                    </div>
                    <button className="btn btn-secondary" disabled={busy}>Save</button>
                  </Form>
                </div>

                {/* SKU mapping */}
                <div>
                  <div className="flex justify-between items-center mb-2">
                    <h3 className="font-semibold">Shopify → Inventory SKU mapping ({mappings.length})</h3>
                    <Form method="post"><input type="hidden" name="intent" value="seed-mappings" /><button className="btn btn-ghost btn-sm" disabled={busy}>Seed known pairs</button></Form>
                  </div>
                  <Form method="post" className="flex flex-wrap items-end gap-2 mb-1">
                    <input type="hidden" name="intent" value="add-mapping" />
                    <div className="form-group mb-0">
                      <label className="form-label">Shopify SKU or pattern (e.g. TR-*)</label>
                      <input type="text" name="alias" className="form-input" placeholder="TR-*" />
                    </div>
                    <div className="form-group mb-0">
                      <label className="form-label">Inventory SKU (exact)</label>
                      <select name="skuId" className="form-select">
                        <option value="">— Select —</option>
                        {skuOptions.map((s) => <option key={s.id} value={s.id}>{s.sku} ({s.type})</option>)}
                      </select>
                    </div>
                    <div className="form-group mb-0">
                      <label className="form-label">Replacement (for pattern)</label>
                      <input type="text" name="replacement" className="form-input" placeholder="TRUMP-*" />
                    </div>
                    <label className="flex items-center gap-1 text-sm mb-2"><input type="checkbox" name="isPattern" /> Wildcard pattern</label>
                    <button className="btn btn-secondary" disabled={busy}>Add</button>
                  </Form>
                  <p className="text-xs text-gray-500 mb-3">Exact: pick an inventory SKU. Pattern: tick “Wildcard pattern” and give a replacement template — the <code>*</code> from the Shopify SKU is substituted in (e.g. <code>TR-*</code> → <code>TRUMP-*</code>).</p>
                  <div className="overflow-x-auto">
                    <table className="data-table">
                      <thead><tr><th>Shopify SKU / pattern</th><th>Type</th><th>Maps to</th><th></th></tr></thead>
                      <tbody>
                        {mappings.map((m) => (
                          <tr key={m.id}>
                            <td className="font-mono">{m.alias}</td>
                            <td>{m.isPattern ? <span className="badge bg-purple-100 text-purple-800">pattern</span> : "exact"}</td>
                            <td className="font-mono">{m.target}</td>
                            <td className="text-right">
                              <Form method="post" className="inline"><input type="hidden" name="intent" value="delete-mapping" /><input type="hidden" name="id" value={m.id} /><button className="btn btn-error btn-sm" disabled={busy}>Delete</button></Form>
                            </td>
                          </tr>
                        ))}
                        {mappings.length === 0 && <tr><td colSpan={4} className="text-center text-gray-500 py-4">No mappings. Click “Seed known pairs”.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Exclusions */}
                <div>
                  <h3 className="font-semibold mb-2">Excluded / manual SKUs ({exclusions.length})</h3>
                  <Form method="post" className="flex flex-wrap items-end gap-2 mb-3">
                    <input type="hidden" name="intent" value="add-exclusion" />
                    <div className="form-group mb-0"><label className="form-label">SKU</label><input type="text" name="sku" className="form-input" /></div>
                    <div className="form-group mb-0"><label className="form-label">Reason (optional)</label><input type="text" name="reason" className="form-input" placeholder="Handled manually" /></div>
                    <button className="btn btn-secondary" disabled={busy}>Add</button>
                  </Form>
                  <div className="overflow-x-auto">
                    <table className="data-table">
                      <thead><tr><th>SKU</th><th>Reason</th><th></th></tr></thead>
                      <tbody>
                        {exclusions.map((e) => (
                          <tr key={e.id}>
                            <td className="font-mono">{e.sku}</td>
                            <td>{e.reason ?? "—"}</td>
                            <td className="text-right"><Form method="post" className="inline"><input type="hidden" name="intent" value="delete-exclusion" /><input type="hidden" name="id" value={e.id} /><button className="btn btn-error btn-sm" disabled={busy}>Delete</button></Form></td>
                          </tr>
                        ))}
                        {exclusions.length === 0 && <tr><td colSpan={3} className="text-center text-gray-500 py-4">No exclusions.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </section>
          )}
        </>
      )}
    </Layout>
  );
}
