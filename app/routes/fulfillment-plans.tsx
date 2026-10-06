import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation, Link, useSearchParams } from "react-router";
import { useState } from "react";
import { requireRole, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import {
  previewPlan,
  commitPlan,
  parseRules,
  toMatrixifyCsv,
  type PlanRule,
  type PlanLocation,
} from "../utils/fulfillment-plan.server";

const DEFAULT_RULES: PlanRule[] = [
  { id: "r1", match: "COC", matchType: "CONTAINS", mode: "QTY", qty: 1 },
  { id: "r2", match: "PT-", matchType: "PREFIX", mode: "ALL", qty: 0 },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN", "MANAGER"]);
  const url = new URL(request.url);
  const planId = url.searchParams.get("plan");

  const plans = await prisma.fulfillmentPlan.findMany({
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { actions: true } }, createdBy: { select: { firstName: true, lastName: true } } },
    take: 50,
  });

  const plan = planId ? await prisma.fulfillmentPlan.findUnique({ where: { id: planId } }) : null;

  // Only build a preview when a plan is open — it hits Shopify and ShipHero.
  let preview = null;
  let previewError: string | null = null;
  if (plan) {
    try {
      preview = await previewPlan({
        planId: plan.id,
        planName: plan.name,
        location: plan.location as PlanLocation,
        storeFilter: plan.storeFilter,
        noteTemplate: plan.noteTemplate,
        rules: parseRules(plan.rules),
        skipActioned: url.searchParams.get("skipActioned") === "1",
      });
    } catch (err) {
      previewError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    user,
    plans: plans.map((p) => ({
      id: p.id, name: p.name, location: p.location, storeFilter: p.storeFilter,
      status: p.status, actions: p._count.actions,
      updatedAt: p.updatedAt.toISOString(),
      author: `${p.createdBy.firstName} ${p.createdBy.lastName}`,
    })),
    plan: plan && {
      id: plan.id, name: plan.name, location: plan.location, storeFilter: plan.storeFilter,
      noteTemplate: plan.noteTemplate, status: plan.status, rules: parseRules(plan.rules),
    },
    preview,
    previewError,
    skipActioned: url.searchParams.get("skipActioned") === "1",
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN", "MANAGER"]);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  if (intent === "create") {
    const name = String(form.get("name") || "").trim() || `Plan ${new Date().toLocaleDateString()}`;
    const created = await prisma.fulfillmentPlan.create({
      data: {
        name,
        location: (String(form.get("location") || "GALLATIN") === "UTAH" ? "UTAH" : "GALLATIN"),
        storeFilter: String(form.get("storeFilter") || "all"),
        rules: DEFAULT_RULES as any,
        createdById: user.id,
      },
    });
    await createAuditLog(user.id, "CREATE_FULFILLMENT_PLAN", "FulfillmentPlan", created.id, { name });
    return { redirectTo: `/fulfillment-plans?plan=${created.id}` };
  }

  const planId = String(form.get("planId") || "");
  if (!planId) return { error: "No plan selected." };

  if (intent === "save") {
    let rules: PlanRule[] = [];
    try { rules = parseRules(JSON.parse(String(form.get("rules") || "[]"))); } catch { rules = []; }
    if (rules.length === 0) return { error: "Add at least one rule — a plan with no rules ships nothing." };
    await prisma.fulfillmentPlan.update({
      where: { id: planId },
      data: {
        name: String(form.get("name") || "").trim() || "Untitled plan",
        location: String(form.get("location") || "GALLATIN") === "UTAH" ? "UTAH" : "GALLATIN",
        storeFilter: String(form.get("storeFilter") || "all"),
        noteTemplate: String(form.get("noteTemplate") || "").trim() || "{plan}: ship {items} from {location}",
        rules: rules as any,
      },
    });
    return { success: true, message: "Plan saved." };
  }

  if (intent === "commit") {
    const plan = await prisma.fulfillmentPlan.findUnique({ where: { id: planId } });
    if (!plan) return { error: "Plan not found." };
    const preview = await previewPlan({
      planId: plan.id, planName: plan.name, location: plan.location as PlanLocation,
      storeFilter: plan.storeFilter, noteTemplate: plan.noteTemplate, rules: parseRules(plan.rules),
      skipActioned: String(form.get("skipActioned") || "") === "1",
    });
    const saved = await commitPlan(plan.id, preview);
    await createAuditLog(user.id, "COMMIT_FULFILLMENT_PLAN", "FulfillmentPlan", plan.id, { orders: saved });
    return { success: true, message: `Marked ${saved} order(s) as actioned under "${plan.name}".` };
  }

  if (intent === "export") {
    const plan = await prisma.fulfillmentPlan.findUnique({ where: { id: planId } });
    if (!plan) return { error: "Plan not found." };
    const preview = await previewPlan({
      planId: plan.id, planName: plan.name, location: plan.location as PlanLocation,
      storeFilter: plan.storeFilter, noteTemplate: plan.noteTemplate, rules: parseRules(plan.rules),
      skipActioned: String(form.get("skipActioned") || "") === "1",
    });
    await commitPlan(plan.id, preview);
    await prisma.fulfillmentPlanAction.updateMany({
      where: { planId: plan.id, status: "PLANNED" },
      data: { status: "EXPORTED", exportedAt: new Date() },
    });
    await createAuditLog(user.id, "EXPORT_FULFILLMENT_PLAN", "FulfillmentPlan", plan.id, { orders: preview.orders.length });
    const csv = toMatrixifyCsv(preview, plan.name);
    const slug = plan.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "plan";
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="matrixify_${slug}_${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

  if (intent === "archive") {
    await prisma.fulfillmentPlan.update({ where: { id: planId }, data: { status: "ARCHIVED" } });
    return { success: true, message: "Plan archived." };
  }

  if (intent === "delete") {
    await prisma.fulfillmentPlan.delete({ where: { id: planId } }).catch(() => {});
    return { redirectTo: "/fulfillment-plans" };
  }

  return { error: "Unknown action." };
};

const num = (n: number) => n.toLocaleString();
const money = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export default function FulfillmentPlans() {
  const { user, plans, plan, preview, previewError, skipActioned } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const [searchParams, setSearchParams] = useSearchParams();
  const [rules, setRules] = useState<PlanRule[]>(plan?.rules ?? []);
  const [open, setOpen] = useState<string | null>(null);

  if (actionData && "redirectTo" in actionData && actionData.redirectTo && typeof window !== "undefined") {
    window.location.href = actionData.redirectTo;
  }

  const setRule = (i: number, patch: Partial<PlanRule>) =>
    setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Layout user={user}>
      <div className="page-header flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">Fulfillment game plans</h1>
          <p className="page-subtitle">
            Rules for partially shipping the backlog — "one COC and all the practice tips on every order".
            Preview what it would pick, export it for Matrixify, and keep a record so no order gets picked twice.
          </p>
        </div>
        <Link to="/unfulfilled" className="btn btn-secondary btn-sm">Unfulfilled orders</Link>
      </div>

      {actionData && "error" in actionData && actionData.error && <div className="alert alert-error mb-4">{actionData.error}</div>}
      {actionData && "message" in actionData && actionData.message && <div className="alert alert-success mb-4">{actionData.message}</div>}
      {previewError && <div className="alert alert-error mb-4">Couldn't build the preview: {previewError}</div>}

      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        {/* Saved plans */}
        <div>
          <div className="card mb-4">
            <div className="card-header !py-3"><span className="text-sm font-semibold">Saved plans</span></div>
            <div className="max-h-[40vh] overflow-y-auto">
              {plans.length === 0 ? (
                <p className="text-sm text-gray-500 px-4 py-5">No plans yet.</p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {plans.map((p) => (
                    <li key={p.id} className={`px-4 py-3 ${plan?.id === p.id ? "bg-beast-50" : ""}`}>
                      <Link to={`/fulfillment-plans?plan=${p.id}`} className="block">
                        <p className={`text-sm ${plan?.id === p.id ? "font-medium text-beast-800" : "text-gray-800"}`}>{p.name}</p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {p.location === "UTAH" ? "Utah" : "Gallatin"} · {p.status.toLowerCase()} · {num(p.actions)} actioned
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <Form method="post" className="card">
            <input type="hidden" name="intent" value="create" />
            <div className="card-body space-y-2">
              <p className="text-sm font-semibold">New plan</p>
              <input name="name" placeholder="e.g. Oct partial ship" className="form-input" />
              <select name="location" className="form-select">
                <option value="GALLATIN">Ship from Gallatin</option>
                <option value="UTAH">Ship from Utah</option>
              </select>
              <select name="storeFilter" className="form-select">
                <option value="all">Both stores</option>
                <option value="beast">Beast only</option>
                <option value="archery">Archery only</option>
              </select>
              <button className="btn btn-primary w-full" disabled={busy}>Create plan</button>
            </div>
          </Form>
        </div>

        {/* Plan editor + preview */}
        <div>
          {!plan ? (
            <div className="card"><div className="card-body text-gray-500">
              Pick a saved plan or create one. A plan is a short list of rules — which SKUs to pull, and how many
              per order — applied to every open order in age order.
            </div></div>
          ) : (
            <>
              <Form method="post" className="card mb-4">
                <input type="hidden" name="intent" value="save" />
                <input type="hidden" name="planId" value={plan.id} />
                <input type="hidden" name="rules" value={JSON.stringify(rules)} />
                <div className="card-body space-y-3">
                  <div className="grid gap-3 md:grid-cols-3">
                    <div>
                      <label className="form-label">Plan name</label>
                      <input name="name" defaultValue={plan.name} className="form-input" />
                    </div>
                    <div>
                      <label className="form-label">Ship from</label>
                      <select name="location" defaultValue={plan.location} className="form-select">
                        <option value="GALLATIN">Gallatin</option>
                        <option value="UTAH">Utah</option>
                      </select>
                    </div>
                    <div>
                      <label className="form-label">Stores</label>
                      <select name="storeFilter" defaultValue={plan.storeFilter} className="form-select">
                        <option value="all">Both</option>
                        <option value="beast">Beast only</option>
                        <option value="archery">Archery only</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="form-label">Rules — what to pull from each order</label>
                    <div className="space-y-2">
                      {rules.map((r, i) => (
                        <div key={r.id} className="flex flex-wrap items-center gap-2">
                          <select value={r.mode} onChange={(e) => setRule(i, { mode: e.target.value as any })} className="form-select" style={{ maxWidth: 130 }}>
                            <option value="QTY">Ship up to</option>
                            <option value="ALL">Ship all</option>
                          </select>
                          {r.mode === "QTY" && (
                            <input type="number" min={1} value={r.qty} onChange={(e) => setRule(i, { qty: parseInt(e.target.value, 10) || 0 })} className="form-input" style={{ maxWidth: 80 }} />
                          )}
                          <select value={r.matchType} onChange={(e) => setRule(i, { matchType: e.target.value as any })} className="form-select" style={{ maxWidth: 140 }}>
                            <option value="CONTAINS">SKU contains</option>
                            <option value="PREFIX">SKU starts with</option>
                            <option value="EXACT">SKU is exactly</option>
                          </select>
                          <input value={r.match} onChange={(e) => setRule(i, { match: e.target.value })} placeholder="COC" className="form-input flex-1" style={{ minWidth: 120 }} />
                          <button type="button" onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))} className="btn btn-secondary btn-sm text-red-600">Remove</button>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => setRules((rs) => [...rs, { id: `r${Date.now()}`, match: "", matchType: "CONTAINS", mode: "QTY", qty: 1 }])}
                      className="btn btn-secondary btn-sm mt-2"
                    >
                      + Add rule
                    </button>
                    <p className="text-xs text-gray-500 mt-2">
                      Rules are tried in order; the first one that matches a line decides it. Nothing is ever planned
                      beyond what the order needs or what the warehouse holds.
                    </p>
                  </div>

                  <div>
                    <label className="form-label">Warehouse note</label>
                    <input name="noteTemplate" defaultValue={plan.noteTemplate} className="form-input" />
                    <p className="text-xs text-gray-500 mt-1">
                      Tokens: <code>{"{plan}"}</code> <code>{"{items}"}</code> <code>{"{location}"}</code> <code>{"{order}"}</code>
                    </p>
                  </div>

                  <div className="flex gap-2 flex-wrap">
                    <button className="btn btn-primary" disabled={busy}>Save plan</button>
                    <label className="text-sm flex items-center gap-1.5 ml-2">
                      <input
                        type="checkbox"
                        checked={skipActioned}
                        onChange={(e) => {
                          const next = new URLSearchParams(searchParams);
                          if (e.target.checked) next.set("skipActioned", "1"); else next.delete("skipActioned");
                          setSearchParams(next, { preventScrollReset: true });
                        }}
                      />
                      Skip orders already actioned by another plan
                    </label>
                  </div>
                </div>
              </Form>

              {preview && (
                <>
                  <div className="stats-grid">
                    <div className="stat-card"><div className="stat-label">Orders in this plan</div><div className="stat-value">{num(preview.totals.orders)}</div></div>
                    <div className="stat-card"><div className="stat-label">Units to pick</div><div className="stat-value">{num(preview.totals.units)}</div></div>
                    <div className="stat-card"><div className="stat-label">Value released</div><div className="stat-value">{money(preview.totals.value)}</div></div>
                    <div className="stat-card"><div className="stat-label">Skipped (already actioned)</div><div className="stat-value">{num(preview.totals.skipped)}</div></div>
                  </div>

                  {preview.shortOf.length > 0 && (
                    <div className="alert alert-warning mb-4">
                      <strong>Not enough stock for every order.</strong> These were allocated oldest first and ran out:{" "}
                      {preview.shortOf.slice(0, 6).map((s) => `${s.sku} (wanted ${s.wanted}, had ${s.available})`).join("; ")}
                      {preview.shortOf.length > 6 ? `; +${preview.shortOf.length - 6} more` : ""}.
                    </div>
                  )}

                  <div className="card">
                    <div className="card-header flex-wrap gap-2">
                      <span className="card-title">What this plan would ship</span>
                      <div className="flex gap-2 flex-wrap">
                        <Form method="post">
                          <input type="hidden" name="intent" value="commit" />
                          <input type="hidden" name="planId" value={plan.id} />
                          <input type="hidden" name="skipActioned" value={skipActioned ? "1" : ""} />
                          <button className="btn btn-secondary btn-sm" disabled={busy || preview.totals.orders === 0}>Mark as actioned</button>
                        </Form>
                        <Form method="post">
                          <input type="hidden" name="intent" value="export" />
                          <input type="hidden" name="planId" value={plan.id} />
                          <input type="hidden" name="skipActioned" value={skipActioned ? "1" : ""} />
                          <button className="btn btn-primary btn-sm" disabled={busy || preview.totals.orders === 0}>Export for Matrixify</button>
                        </Form>
                      </div>
                    </div>
                    <div className="card-body">
                      <div className="overflow-x-auto">
                        <table className="data-table">
                          <thead>
                            <tr><th></th><th>Order</th><th>Store</th><th>Customer</th><th>Waiting</th><th>Picking</th><th>Value</th><th>Note</th><th>Already actioned</th></tr>
                          </thead>
                          <tbody>
                            {preview.orders.length === 0 && (
                              <tr><td colSpan={9} className="text-center text-gray-500 py-6">No order matches these rules right now.</td></tr>
                            )}
                            {preview.orders.map((o) => {
                              const key = `${o.store}:${o.orderId}`;
                              return [
                                <tr key={key} onClick={() => setOpen(open === key ? null : key)} className="cursor-pointer">
                                  <td className="text-gray-400">{open === key ? "▾" : "▸"}</td>
                                  <td className="font-medium">{o.orderName}</td>
                                  <td><span className={`badge ${o.store === "beast" ? "badge-purple" : "badge-blue"}`}>{o.store === "beast" ? "Beast" : "Archery"}</span></td>
                                  <td>{o.customer || "—"}</td>
                                  <td className={o.ageDays > 14 ? "text-red-600" : ""}>{o.ageDays}d</td>
                                  <td>{num(o.units)} of {num(o.totalNeeded)}</td>
                                  <td className="tabular-nums">{money(o.value)}</td>
                                  <td className="text-xs text-gray-600">{o.note}</td>
                                  <td>
                                    {o.existing.length === 0 ? (
                                      <span className="text-gray-400 text-xs">—</span>
                                    ) : (
                                      <span className={`badge ${o.inThisPlan ? "badge-blue" : "badge-yellow"}`}>
                                        {o.inThisPlan ? "this plan" : o.existing[0].planName}
                                      </span>
                                    )}
                                  </td>
                                </tr>,
                                open === key && (
                                  <tr key={`${key}-x`}>
                                    <td></td>
                                    <td colSpan={8} className="bg-gray-50">
                                      <div className="overflow-x-auto py-2">
                                        <table className="data-table text-sm">
                                          <thead><tr><th>SKU</th><th>Product</th><th>Qty</th><th>Matched by</th></tr></thead>
                                          <tbody>
                                            {o.lines.map((l, i) => (
                                              <tr key={i}><td className="font-mono text-xs">{l.sku}</td><td>{l.title}</td><td>{num(l.qty)}</td><td className="text-xs text-gray-500">{l.rule}</td></tr>
                                            ))}
                                          </tbody>
                                        </table>
                                        {o.existing.length > 0 && (
                                          <p className="text-xs text-gray-600 mt-2">
                                            Already actioned: {o.existing.map((e) => `${e.planName} (${e.units} units, ${e.status.toLowerCase()})`).join("; ")}
                                          </p>
                                        )}
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
                </>
              )}
            </>
          )}
        </div>
      </div>
    </Layout>
  );
}
