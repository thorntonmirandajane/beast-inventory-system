import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation, Link } from "react-router";
import { useState } from "react";
import { requireRole } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import { computeBuildPlan, type BuildPlanRow } from "../utils/operations.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN", "MANAGER"]);
  const plan = await computeBuildPlan([]);
  return { user, plan };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await requireRole(request, ["ADMIN", "MANAGER"]);
  const form = await request.formData();
  const skuIds = form.getAll("skuId").map(String);
  const qtys = form.getAll("qty").map((v) => parseInt(String(v), 10));
  const extra = skuIds
    .map((skuId, i) => ({ skuId, qty: qtys[i] }))
    .filter((e) => e.skuId && Number.isFinite(e.qty) && e.qty > 0);

  const [base, withExtra] = await Promise.all([computeBuildPlan([]), computeBuildPlan(extra)]);
  const baseShort = new Map(base.rows.map((r) => [r.skuId, r.short]));
  const rows = withExtra.rows.map((r) => ({
    ...r,
    extraCovered: Math.max(0, (baseShort.get(r.skuId) ?? 0) - r.short),
  }));
  const totalExtraCovered = rows.reduce((s, r) => s + r.extraCovered, 0);
  return { plan: { ...withExtra, rows }, applied: extra, baseShort: base.totals.short, totalExtraCovered };
};

type Row = BuildPlanRow & { extraCovered?: number };

export default function Operations() {
  const { user, plan: basePlan } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  const plan = actionData?.plan ?? basePlan;
  const rows = plan.rows as Row[];
  const options = basePlan.componentOptions;
  const whatIf = !!actionData?.applied?.length;

  const [extraRows, setExtraRows] = useState<{ skuId: string; qty: string }[]>([{ skuId: "", qty: "" }]);
  const setRow = (i: number, k: "skuId" | "qty", v: string) =>
    setExtraRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  const num = (n: number) => n.toLocaleString();

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Operations — Build Plan</h1>
        <p className="page-subtitle">
          What we can build right now with on-hand components, and what it covers. Add expected
          incoming material to run a what-if. Shared components fill unfulfilled orders first
          (oldest), then programmed orders.
        </p>
      </div>

      {/* Summary */}
      <div className="stats-grid mb-6">
        <div className="stat-card"><div className="stat-value">{num(plan.totals.unfulfilled)}</div><div className="stat-label">Unfulfilled (waiting)</div></div>
        <div className="stat-card"><div className="stat-value">{num(plan.totals.programmed)}</div><div className="stat-label">Programmed (coming)</div></div>
        <div className="stat-card"><div className="stat-value text-green-600">{num(plan.totals.built)}</div><div className="stat-label">Can build now</div></div>
        <div className="stat-card"><div className={`stat-value ${plan.totals.short > 0 ? "text-red-600" : "text-green-600"}`}>{num(plan.totals.short)}</div><div className="stat-label">Still short</div></div>
      </div>

      {/* What-if */}
      <div className="card mb-6">
        <div className="card-body">
          <h2 className="card-title">What-if: add expected incoming materials</h2>
          <p className="text-sm text-gray-600 mb-3">
            e.g. "+2600 COC ferrules tomorrow" — add the component and quantity, apply, and see how
            much more it lets you build and cover.
          </p>
          <Form method="post">
            <div className="space-y-2">
              {extraRows.map((r, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <select
                    name="skuId"
                    value={r.skuId}
                    onChange={(e) => setRow(i, "skuId", e.target.value)}
                    className="form-input"
                    style={{ minWidth: 320 }}
                  >
                    <option value="">Choose a component…</option>
                    {options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.sku} — {o.name} ({o.type})
                      </option>
                    ))}
                  </select>
                  <input
                    name="qty"
                    type="number"
                    min={1}
                    placeholder="qty"
                    value={r.qty}
                    onChange={(e) => setRow(i, "qty", e.target.value)}
                    className="form-input w-28"
                  />
                  {extraRows.length > 1 && (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setExtraRows((rs) => rs.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-3">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setExtraRows((rs) => [...rs, { skuId: "", qty: "" }])}>
                + Add material
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? "Calculating…" : "Apply what-if"}
              </button>
              {whatIf && (
                <Link to="/operations" className="btn btn-secondary">Reset to current inventory</Link>
              )}
            </div>
          </Form>

          {whatIf && (
            <div className="alert alert-success mt-3">
              Your additions let you build & cover <strong>{num(actionData!.totalExtraCovered)}</strong> more unit(s)
              — still-short dropped from {num(actionData!.baseShort)} to {num(plan.totals.short)}.
            </div>
          )}
        </div>
      </div>

      {/* Build plan table */}
      <div className="card">
        <div className="card-header"><h2 className="card-title">Completed SKUs</h2></div>
        <div className="card-body overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b">
                <th className="py-2 pr-4">SKU</th>
                <th className="py-2 pr-4">Product</th>
                <th className="py-2 pr-4 text-right">Unfulfilled</th>
                <th className="py-2 pr-4 text-right">Programmed</th>
                <th className="py-2 pr-4 text-right">In stock</th>
                <th className="py-2 pr-4 text-right">Gallatin</th>
                <th className="py-2 pr-4 text-right">Can build</th>
                <th className="py-2 pr-4 text-right">Short</th>
                {whatIf && <th className="py-2 pr-4 text-right">Extra covered</th>}
                <th className="py-2 pr-4">Binding material</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.skuId} className={`border-b last:border-0 ${r.short > 0 ? "bg-red-50" : ""}`}>
                  <td className="py-2 pr-4 font-mono">{r.sku}</td>
                  <td className="py-2 pr-4">{r.name}</td>
                  <td className="py-2 pr-4 text-right">{r.unfulfilled ? num(r.unfulfilled) : "—"}</td>
                  <td className="py-2 pr-4 text-right">{r.programmed ? num(r.programmed) : "—"}</td>
                  <td className="py-2 pr-4 text-right">{num(r.stockLocal)}</td>
                  <td className="py-2 pr-4 text-right">{num(r.stockGallatin)}</td>
                  <td className="py-2 pr-4 text-right font-medium text-green-700">{r.built ? num(r.built) : "—"}</td>
                  <td className={`py-2 pr-4 text-right ${r.short > 0 ? "text-red-600 font-medium" : ""}`}>{r.short ? num(r.short) : "—"}</td>
                  {whatIf && <td className="py-2 pr-4 text-right text-green-700">{r.extraCovered ? `+${num(r.extraCovered)}` : "—"}</td>}
                  <td className="py-2 pr-4 text-xs text-gray-600">{r.bindingSku ? `${r.bindingSku}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {plan.unmatchedDemand.length > 0 && (
        <div className="alert alert-warning mt-4">
          <strong>{plan.unmatchedDemand.length} SKU(s)</strong> with orders don't match a product and were skipped:{" "}
          {plan.unmatchedDemand.slice(0, 8).map((u) => `${u.sku} ×${num(u.qty)}`).join(", ")}
          {plan.unmatchedDemand.length > 8 ? "…" : ""}. Map them on the{" "}
          <Link to="/projections" className="underline">Projections</Link> page.
        </div>
      )}
    </Layout>
  );
}
