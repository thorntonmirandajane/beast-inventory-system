import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
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

  if (intent === "save-projection-settings") {
    const scenario = await getOrCreateScenario();
    const multiplier = parseFloat(formData.get("globalMultiplier") as string);
    const cmpStart = formData.get("comparisonStart") as string;
    const cmpEnd = formData.get("comparisonEnd") as string;
    await prisma.forecastScenario.update({
      where: { id: scenario.id },
      data: {
        globalMultiplier: isNaN(multiplier) || multiplier < 0 ? scenario.globalMultiplier : multiplier,
        comparisonStart: cmpStart ? new Date(`${cmpStart}T00:00:00Z`) : scenario.comparisonStart,
        comparisonEnd: cmpEnd ? new Date(`${cmpEnd}T00:00:00Z`) : scenario.comparisonEnd,
      },
    });
    return { success: true, message: "Settings saved. Refresh sales & orders if you changed the comparison window." };
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
    const skus = await prisma.sku.findMany({ where: { isActive: true, type: "COMPLETED" }, select: { id: true } });
    let changed = 0;
    for (const s of skus) {
      const raw = (formData.get(`override_${s.id}`) as string | null)?.trim();
      if (raw == null || raw === "") {
        const del = await prisma.forecastOverride.deleteMany({ where: { skuId: s.id } });
        changed += del.count;
        continue;
      }
      const qty = parseInt(raw, 10);
      if (isNaN(qty) || qty < 0) continue;
      await prisma.forecastOverride.upsert({
        where: { skuId: s.id },
        create: { skuId: s.id, overrideQty: qty, updatedBy: user.id },
        update: { overrideQty: qty, updatedBy: user.id },
      });
      changed++;
    }
    await createAuditLog(user.id, "SAVE_PROJECTION_OVERRIDES", "ForecastOverride", "", { changed });
    return { success: true, message: "Saved projection overrides." };
  }

  if (intent === "reset-projection-overrides") {
    const { count } = await prisma.forecastOverride.deleteMany();
    await createAuditLog(user.id, "RESET_PROJECTION_OVERRIDES", "ForecastOverride", "", { cleared: count });
    return { success: true, message: `Cleared ${count} override(s).` };
  }

  return { error: "Invalid action" };
};

export default function Projections() {
  const { user, projection } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const { scenario, rows, adequacy, materialGroups } = projection;
  const cmpStart = new Date(scenario.comparisonStart).toISOString().split("T")[0];
  const cmpEnd = new Date(scenario.comparisonEnd).toISOString().split("T")[0];
  const refreshed = scenario.salesRefreshedAt ? new Date(scenario.salesRefreshedAt).toLocaleString() : null;
  const num = (n: number) => n.toLocaleString();

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Projections</h1>
        <p className="page-subtitle">
          Demand = Fulfilled + Unfulfilled + Programmed + Planned projection. Per-SKU override always wins.
        </p>
      </div>

      {actionData && "error" in actionData && actionData.error && (
        <div className="alert alert-error mb-4">{actionData.error}</div>
      )}
      {actionData && "success" in actionData && actionData.success && (
        <div className="alert alert-success mb-4">{actionData.message}</div>
      )}

      {/* Controls */}
      <div className="card mb-4">
        <div className="card-body flex flex-wrap items-end gap-4">
          <Form method="post" className="flex items-end gap-3 flex-wrap">
            <input type="hidden" name="intent" value="save-projection-settings" />
            <div className="form-group mb-0">
              <label className="form-label">Global multiplier</label>
              <input type="number" name="globalMultiplier" step="0.1" min="0" defaultValue={scenario.globalMultiplier} className="form-input w-28" />
            </div>
            <div className="form-group mb-0">
              <label className="form-label">Compare from</label>
              <input type="date" name="comparisonStart" defaultValue={cmpStart} className="form-input" />
            </div>
            <div className="form-group mb-0">
              <label className="form-label">Compare to</label>
              <input type="date" name="comparisonEnd" defaultValue={cmpEnd} className="form-input" />
            </div>
            <button type="submit" className="btn btn-secondary" disabled={isSubmitting}>Save settings</button>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="refresh-projection-sales" />
            <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
              {isSubmitting ? "Working…" : "Refresh sales & orders"}
            </button>
          </Form>
          <span className="text-xs text-gray-500">
            {refreshed ? `Last refreshed ${refreshed}` : "Not refreshed yet — click Refresh to pull Shopify + programmed orders."}
          </span>
        </div>
      </div>

      {/* Material Adequacy */}
      <div className="card mb-4">
        <div className="card-header">
          <h2 className="card-title">Material Adequacy</h2>
          <p className="text-sm text-gray-500">Projected raw need (full BOM) vs on-hand (available) + open POs. Negative net = short.</p>
        </div>
        <div className="card-body overflow-x-auto">
          <table className="data-table mb-6">
            <thead>
              <tr>
                <th>Material</th>
                <th className="text-right">Projected Need</th>
                <th className="text-right">On Hand</th>
                <th className="text-right">On Order</th>
                <th className="text-right">Net</th>
              </tr>
            </thead>
            <tbody>
              {materialGroups.map((g) => (
                <tr key={g.material}>
                  <td className="font-medium">{g.material}</td>
                  <td className="text-right">{num(g.projectedNeed)}</td>
                  <td className="text-right">{num(g.onHand)}</td>
                  <td className="text-right">{num(g.onOrder)}</td>
                  <td className="text-right font-bold" style={{ color: g.net < 0 ? "#ef4444" : "#10b981" }}>{num(g.net)}</td>
                </tr>
              ))}
              {materialGroups.length === 0 && (
                <tr><td colSpan={5} className="text-center text-gray-500 py-6">No raw need yet — set projections and refresh.</td></tr>
              )}
            </tbody>
          </table>

          {adequacy.length > 0 && (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Raw SKU</th>
                  <th>Name</th>
                  <th>Material</th>
                  <th className="text-right">Projected Need</th>
                  <th className="text-right">On Hand</th>
                  <th className="text-right">On Order</th>
                  <th className="text-right">Net</th>
                </tr>
              </thead>
              <tbody>
                {adequacy.map((r) => (
                  <tr key={r.skuId} style={r.net < 0 ? { background: "#fef2f2" } : undefined}>
                    <td className="font-mono text-sm">{r.sku}</td>
                    <td className="text-sm">{r.name}</td>
                    <td className="text-sm">{r.material}</td>
                    <td className="text-right">{num(r.projectedNeed)}</td>
                    <td className="text-right">{num(r.onHand)}</td>
                    <td className="text-right">{num(r.onOrder)}</td>
                    <td className="text-right font-semibold" style={{ color: r.net < 0 ? "#ef4444" : "#10b981" }}>{num(r.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* SKU-level projection — editable overrides */}
      <div className="card">
        <div className="card-header flex items-center justify-between">
          <h2 className="card-title">SKU-level Projection ({rows.length})</h2>
          <Form method="post" onSubmit={(e) => { if (!confirm("Clear all per-SKU overrides?")) e.preventDefault(); }}>
            <input type="hidden" name="intent" value="reset-projection-overrides" />
            <button type="submit" className="btn btn-ghost btn-sm text-red-600" disabled={isSubmitting}>Reset overrides</button>
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
                  <th className="text-right" title="YTD shipped">Fulfilled</th>
                  <th className="text-right" title="YTD placed, not shipped">Unfulfilled</th>
                  <th className="text-right" title="Future dealer/programmed orders">Programmed</th>
                  <th className="text-right" title="multiplier × prior-year comparable">Planned proj.</th>
                  <th className="text-right">Projected total</th>
                  <th className="text-right">Override</th>
                  <th className="text-right">Final</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.skuId}>
                    <td className="font-mono text-sm">{r.sku}</td>
                    <td className="text-sm">{r.name}</td>
                    <td className="text-right">{num(r.fulfilled)}</td>
                    <td className="text-right">{num(r.unfulfilled)}</td>
                    <td className="text-right">{num(r.programmed)}</td>
                    <td className="text-right" title={`${r.multiplier}× ${num(r.priorComp)} prior-yr`}>{num(r.plannedProjected)}</td>
                    <td className="text-right">{num(r.formulaTotal)}</td>
                    <td className="text-right">
                      <input
                        type="number"
                        name={`override_${r.skuId}`}
                        min="0"
                        defaultValue={r.override ?? ""}
                        placeholder="—"
                        className="form-input text-sm py-1 px-2 w-24 text-right"
                      />
                    </td>
                    <td className="text-right font-bold" style={r.override != null ? { color: "#2563eb" } : undefined}>{num(r.final)}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={9} className="text-center text-gray-500 py-6">No completed SKUs.</td></tr>
                )}
              </tbody>
            </table>
            <div className="mt-4 pt-4 border-t flex items-center gap-3">
              <button type="submit" className="btn btn-primary" disabled={isSubmitting}>Save overrides</button>
              <span className="text-xs text-gray-500">Blank an override to clear it. Final (blue) = overridden; otherwise = projected total.</span>
            </div>
          </Form>
        </div>
      </div>
    </Layout>
  );
}
