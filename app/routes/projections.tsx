import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import { useState } from "react";
import { requireRole, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { computeProjections, refreshSales, getOrCreateScenario } from "../utils/projection.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN", "MANAGER"]);
  const projection = await computeProjections();
  return { user, projection };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN", "MANAGER"]);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const date = (v: string) => (v ? new Date(`${v}T00:00:00Z`) : null);

  if (intent === "save-projection-settings") {
    const scenario = await getOrCreateScenario();
    const multiplier = parseFloat(formData.get("globalMultiplier") as string);
    await prisma.forecastScenario.update({
      where: { id: scenario.id },
      data: {
        globalMultiplier: isNaN(multiplier) || multiplier < 0 ? scenario.globalMultiplier : multiplier,
        salesStart: date(formData.get("salesStart") as string) ?? scenario.salesStart,
        salesEnd: date(formData.get("salesEnd") as string) ?? scenario.salesEnd,
        comparisonStart: date(formData.get("comparisonStart") as string) ?? scenario.comparisonStart,
        comparisonEnd: date(formData.get("comparisonEnd") as string) ?? scenario.comparisonEnd,
      },
    });
    return { success: true, message: "Settings saved. Refresh sales & orders if you changed a date window." };
  }

  if (intent === "refresh-projection-sales") {
    try {
      const n = await refreshSales();
      await createAuditLog(user.id, "REFRESH_PROJECTION_SALES", "ForecastScenario", "", { skus: n });
      return { success: true, message: `Refreshed sales & orders for ${n} SKUs.` };
    } catch (e) {
      return { error: `Refresh failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  if (intent === "save-projection-overrides") {
    // Planned Projection is editable. Only store an override when it differs from
    // the formula (multiplier × prior) so un-edited rows stay multiplier-driven.
    const scenario = await getOrCreateScenario();
    const sales = await prisma.projectionSale.findMany();
    const priorBySku = new Map(sales.map((s) => [s.skuId, s.priorQty]));
    const skus = await prisma.sku.findMany({ where: { isActive: true, type: "COMPLETED" }, select: { id: true } });
    let changed = 0;
    for (const s of skus) {
      const raw = (formData.get(`planned_${s.id}`) as string | null)?.trim();
      const computed = Math.round(scenario.globalMultiplier * (priorBySku.get(s.id) ?? 0));
      if (raw == null || raw === "") {
        changed += (await prisma.forecastOverride.deleteMany({ where: { skuId: s.id } })).count;
        continue;
      }
      const qty = parseInt(raw, 10);
      if (isNaN(qty) || qty < 0) continue;
      if (qty === computed) {
        changed += (await prisma.forecastOverride.deleteMany({ where: { skuId: s.id } })).count;
        continue;
      }
      await prisma.forecastOverride.upsert({
        where: { skuId: s.id },
        create: { skuId: s.id, overrideQty: qty, updatedBy: user.id },
        update: { overrideQty: qty, updatedBy: user.id },
      });
      changed++;
    }
    await createAuditLog(user.id, "SAVE_PROJECTION_OVERRIDES", "ForecastOverride", "", { changed });
    return { success: true, message: "Saved planned projections." };
  }

  if (intent === "reset-projection-overrides") {
    const { count } = await prisma.forecastOverride.deleteMany();
    await createAuditLog(user.id, "RESET_PROJECTION_OVERRIDES", "ForecastOverride", "", { cleared: count });
    return { success: true, message: `Reset ${count} planned projection(s) to the formula.` };
  }

  return { error: "Invalid action" };
};

const num = (n: number) => n.toLocaleString();

export default function Projections() {
  const { user, projection } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const { scenario, completedRows, rawRows, salesStart, salesEnd, comparisonStart, comparisonEnd } = projection;
  const refreshed = scenario.salesRefreshedAt ? new Date(scenario.salesRefreshedAt).toLocaleString() : null;

  // Live planned-projection editing (total updates as you type).
  const [planned, setPlanned] = useState<Record<string, string>>(() =>
    Object.fromEntries(completedRows.map((r) => [r.skuId, String(r.plannedProjection)]))
  );
  const plannedOf = (id: string, fallback: number) => {
    const v = parseInt(planned[id] ?? "", 10);
    return isNaN(v) ? fallback : v;
  };

  // Organize rows.
  const [topSort, setTopSort] = useState<"needToOrder" | "total2026" | "partType" | "material" | "category" | "sku">("needToOrder");
  const [botSort, setBotSort] = useState<"total2026" | "category" | "name" | "sku">("category");

  const sortedRaw = [...rawRows].sort((a, b) => {
    if (topSort === "needToOrder") return b.needToOrder - a.needToOrder;
    if (topSort === "total2026") return b.total2026 - a.total2026;
    if (topSort === "sku") return a.sku.localeCompare(b.sku);
    return (a[topSort] as string).localeCompare(b[topSort] as string) || a.sku.localeCompare(b.sku);
  });
  const sortedCompleted = [...completedRows].sort((a, b) => {
    if (botSort === "total2026") return b.total2026 - a.total2026;
    if (botSort === "sku") return a.sku.localeCompare(b.sku);
    if (botSort === "name") return a.name.localeCompare(b.name);
    return a.category.localeCompare(b.category) || a.name.localeCompare(b.name);
  });

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Projections</h1>
        <p className="page-subtitle">2026 demand by SKU and raw material. Edit Planned Projection and save; everything else recalculates.</p>
      </div>

      {actionData && "error" in actionData && actionData.error && <div className="alert alert-error mb-4">{actionData.error}</div>}
      {actionData && "success" in actionData && actionData.success && <div className="alert alert-success mb-4">{actionData.message}</div>}

      {/* Controls */}
      <div className="card mb-4">
        <div className="card-body flex flex-wrap items-end gap-4">
          <Form method="post" className="flex items-end gap-3 flex-wrap">
            <input type="hidden" name="intent" value="save-projection-settings" />
            <div className="form-group mb-0">
              <label className="form-label">Sales date from</label>
              <input type="date" name="salesStart" defaultValue={salesStart} className="form-input" />
            </div>
            <div className="form-group mb-0">
              <label className="form-label">to</label>
              <input type="date" name="salesEnd" defaultValue={salesEnd} className="form-input" />
            </div>
            <div className="form-group mb-0">
              <label className="form-label">Projection from</label>
              <input type="date" name="comparisonStart" defaultValue={comparisonStart} className="form-input" />
            </div>
            <div className="form-group mb-0">
              <label className="form-label">to</label>
              <input type="date" name="comparisonEnd" defaultValue={comparisonEnd} className="form-input" />
            </div>
            <div className="form-group mb-0">
              <label className="form-label">Multiplier</label>
              <input type="number" name="globalMultiplier" step="0.1" min="0" defaultValue={scenario.globalMultiplier} className="form-input w-24" />
            </div>
            <button type="submit" className="btn btn-secondary" disabled={isSubmitting}>Save settings</button>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="refresh-projection-sales" />
            <button type="submit" className="btn btn-primary" disabled={isSubmitting}>{isSubmitting ? "Working…" : "Refresh sales & orders"}</button>
          </Form>
          <span className="text-xs text-gray-500">{refreshed ? `Last refreshed ${refreshed}` : "Not refreshed yet — click Refresh."}</span>
        </div>
      </div>

      {/* SKU projection (editable) — sits right under the settings */}
      <div className="card mb-6">
        <div className="card-header flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="card-title">SKU Projection ({completedRows.length})</h2>
            <select value={botSort} onChange={(e) => setBotSort(e.target.value as typeof botSort)} className="form-select text-sm py-1.5">
              <option value="category">Group by category</option>
              <option value="name">Sort by name</option>
              <option value="sku">Sort by SKU</option>
              <option value="total2026">Sort by 2026 total</option>
            </select>
          </div>
          <Form method="post" onSubmit={(e) => { if (!confirm("Reset all planned projections to the formula?")) e.preventDefault(); }}>
            <input type="hidden" name="intent" value="reset-projection-overrides" />
            <button type="submit" className="btn btn-ghost btn-sm text-red-600" disabled={isSubmitting}>Reset to formula</button>
          </Form>
        </div>
        <div className="card-body overflow-x-auto">
          <Form method="post">
            <input type="hidden" name="intent" value="save-projection-overrides" />
            <table className="data-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Name</th>
                  <th className="text-right">Fulfilled</th>
                  <th className="text-right">Unfulfilled</th>
                  <th className="text-right">Programmed</th>
                  <th className="text-right">Planned projection</th>
                  <th className="text-right">2026 Total Needed</th>
                </tr>
              </thead>
              <tbody>
                {sortedCompleted.map((r) => {
                  const p = plannedOf(r.skuId, r.plannedProjection);
                  const total = r.fulfilled + r.unfulfilled + r.programmed + p;
                  return (
                    <tr key={r.skuId}>
                      <td className="font-mono text-sm">{r.sku}</td>
                      <td className="text-sm">{r.name}</td>
                      <td className="text-right">{num(r.fulfilled)}</td>
                      <td className="text-right">{num(r.unfulfilled)}</td>
                      <td className="text-right">{num(r.programmed)}</td>
                      <td className="text-right">
                        <input
                          type="number"
                          name={`planned_${r.skuId}`}
                          min="0"
                          value={planned[r.skuId] ?? ""}
                          onChange={(e) => setPlanned((m) => ({ ...m, [r.skuId]: e.target.value }))}
                          title={`Formula: ${scenario.globalMultiplier}× prior = ${num(r.computedPlanned)}`}
                          className="form-input text-sm py-1 px-2 w-28 text-right"
                          style={r.isOverridden ? { color: "#2563eb", fontWeight: 600 } : undefined}
                        />
                      </td>
                      <td className="text-right font-bold">{num(total)}</td>
                    </tr>
                  );
                })}
                {completedRows.length === 0 && (
                  <tr><td colSpan={7} className="text-center text-gray-500 py-6">No completed SKUs.</td></tr>
                )}
              </tbody>
            </table>
            <div className="mt-4 pt-4 border-t flex items-center gap-3">
              <button type="submit" className="btn btn-primary" disabled={isSubmitting}>Save planned projections</button>
              <span className="text-xs text-gray-500">Edit a Planned Projection to override the formula (mult × prior). Blank or matching the formula keeps it multiplier-driven.</span>
            </div>
          </Form>
        </div>
      </div>

      {/* Raw material needs (derived from the projection above) */}
      <div className="card">
        <div className="card-header flex items-center justify-between">
          <h2 className="card-title">Raw Materials — 2026 Need ({rawRows.length})</h2>
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600">Organize by</label>
            <select value={topSort} onChange={(e) => setTopSort(e.target.value as typeof topSort)} className="form-select text-sm py-1.5">
              <option value="needToOrder">Need to order</option>
              <option value="total2026">2026 total</option>
              <option value="partType">Part type</option>
              <option value="material">Material</option>
              <option value="category">Category</option>
              <option value="sku">SKU</option>
            </select>
          </div>
        </div>
        <div className="card-body overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Name</th>
                <th>Part type</th>
                <th className="text-right">Fulfilled</th>
                <th className="text-right">Unfulfilled</th>
                <th className="text-right">Programmed</th>
                <th className="text-right">Planned proj.</th>
                <th className="text-right" title="unfulfilled + programmed + planned">Qty still needed</th>
                <th className="text-right">On hand</th>
                <th className="text-right" title="raws in built (assembled + completed) stock">In assembly</th>
                <th className="text-right">On order</th>
                <th className="text-right" title="still needed − on hand − in assembly − on order">Need to order</th>
                <th className="text-right">2026 total</th>
              </tr>
            </thead>
            <tbody>
              {sortedRaw.map((r) => (
                <tr key={r.skuId} style={r.needToOrder > 0 ? { background: "#fef2f2" } : undefined}>
                  <td className="font-mono text-sm">{r.sku}</td>
                  <td className="text-sm">{r.name}</td>
                  <td className="text-sm">{r.partType}</td>
                  <td className="text-right">{num(r.fulfilled)}</td>
                  <td className="text-right">{num(r.unfulfilled)}</td>
                  <td className="text-right">{num(r.programmed)}</td>
                  <td className="text-right">{num(r.plannedProjection)}</td>
                  <td className="text-right font-medium">{num(r.qtyStillNeeded)}</td>
                  <td className="text-right">{num(r.onHand)}</td>
                  <td className="text-right">{num(r.inAssembly)}</td>
                  <td className="text-right">{num(r.onOrder)}</td>
                  <td className="text-right font-bold" style={{ color: r.needToOrder > 0 ? "#ef4444" : "#10b981" }}>{num(r.needToOrder)}</td>
                  <td className="text-right">{num(r.total2026)}</td>
                </tr>
              ))}
              {rawRows.length === 0 && (
                <tr><td colSpan={13} className="text-center text-gray-500 py-6">No raw need yet — set projections and refresh.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

    </Layout>
  );
}
