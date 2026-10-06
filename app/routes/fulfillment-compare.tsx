import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation, Link } from "react-router";
import { useState } from "react";
import { requireRole, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { compareStrategies, type StrategyResult, type ShipFrom } from "../utils/fulfillment-strategy.server";
import { STRATEGIES, type StrategyKind } from "../utils/strategy-kinds";

const DEFAULT_KINDS: StrategyKind[] = ["FULL_FIRST_THEN_PARTIAL", "OLDEST_FIRST", "FULL_ONLY"];
const asShipFrom = (v: string | null): ShipFrom =>
  v === "UTAH" ? "UTAH" : v === "EITHER" ? "EITHER" : "GALLATIN";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN", "MANAGER"]);
  const url = new URL(request.url);

  const scenarios = await prisma.fulfillmentScenario.findMany({
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: { id: true, name: true, location: true, storeFilter: true, updatedAt: true, strategies: true },
  });

  const scenarioId = url.searchParams.get("scenario");
  const saved = scenarioId ? scenarios.find((s) => s.id === scenarioId) ?? null : null;
  const savedFull = scenarioId
    ? await prisma.fulfillmentScenario.findUnique({ where: { id: scenarioId } })
    : null;

  // A saved scenario supplies the inputs unless the URL overrides them.
  const picked = url.searchParams.getAll("s").filter((k) => STRATEGIES.some((x) => x.kind === k)) as StrategyKind[];
  const kinds = picked.length
    ? picked
    : savedFull && Array.isArray(savedFull.strategies) && savedFull.strategies.length
    ? (savedFull.strategies as StrategyKind[])
    : DEFAULT_KINDS;
  const location = url.searchParams.has("location")
    ? asShipFrom(url.searchParams.get("location"))
    : asShipFrom(savedFull?.location ?? null);
  const storeFilter = url.searchParams.get("store") ?? savedFull?.storeFilter ?? "all";
  const customersRaw = url.searchParams.has("customers")
    ? url.searchParams.get("customers") ?? ""
    : savedFull?.priorityCustomers ?? "";
  const customers = customersRaw.split(",").map((c) => c.trim()).filter(Boolean);

  let data = null;
  let error: string | null = null;
  try {
    data = await compareStrategies({ kinds, location, storeFilter, priorityCustomers: customers });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return {
    user, data, error, kinds, location, storeFilter,
    customers: customersRaw,
    scenarios: scenarios.map((s) => ({
      id: s.id, name: s.name, location: s.location, storeFilter: s.storeFilter,
      updatedAt: s.updatedAt.toISOString(),
      count: Array.isArray(s.strategies) ? s.strategies.length : 0,
    })),
    scenario: saved ? { id: saved.id, name: saved.name } : null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN", "MANAGER"]);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  const inputs = {
    location: asShipFrom(String(form.get("location") || "")),
    storeFilter: String(form.get("store") || "all"),
    priorityCustomers: String(form.get("customers") || ""),
    strategies: form.getAll("s").map(String).filter((k) => STRATEGIES.some((x) => x.kind === k)),
  };

  if (intent === "save" || intent === "save-as") {
    const name = String(form.get("name") || "").trim();
    if (!name) return { error: "Give the scenario a name so it can be found again." };
    if (inputs.strategies.length === 0) return { error: "Pick at least one strategy before saving." };

    const existingId = intent === "save" ? String(form.get("scenarioId") || "") : "";
    const saved = existingId
      ? await prisma.fulfillmentScenario.update({
          where: { id: existingId },
          data: { name, ...inputs, strategies: inputs.strategies as any },
        })
      : await prisma.fulfillmentScenario.create({
          data: { name, ...inputs, strategies: inputs.strategies as any, createdById: user.id },
        });
    await createAuditLog(user.id, "SAVE_FULFILLMENT_SCENARIO", "FulfillmentScenario", saved.id, { name });
    return { savedId: saved.id, message: `Saved "${name}".` };
  }

  if (intent === "delete") {
    const id = String(form.get("scenarioId") || "");
    if (id) await prisma.fulfillmentScenario.delete({ where: { id } }).catch(() => {});
    return { deleted: true, message: "Scenario deleted." };
  }

  return { error: "Unknown action." };
};

const num = (n: number) => n.toLocaleString();
const money = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
const SOURCE_LABEL: Record<string, string> = { GALLATIN: "Gallatin", UTAH: "Utah", BOTH: "Both", NONE: "—" };
const SOURCE_CLASS: Record<string, string> = { GALLATIN: "badge-blue", UTAH: "badge-purple", BOTH: "badge-yellow", NONE: "badge-gray" };

/** A card whose body folds away. Closed by default — these tables run long. */
function Accordion({
  title,
  summary,
  children,
}: {
  title: string;
  summary?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card mb-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="card-header w-full text-left cursor-pointer hover:bg-gray-50 transition-colors"
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-gray-400 shrink-0">{open ? "▾" : "▸"}</span>
          <span className="card-title truncate">{title}</span>
        </span>
        {summary && <span className="text-xs text-gray-500 shrink-0 ml-2">{summary}</span>}
      </button>
      {open && <div className="card-body">{children}</div>}
    </div>
  );
}

function StrategyCard({ r, totals, best }: {
  r: StrategyResult;
  totals: { orders: number; units: number; value: number };
  best: Record<string, boolean>;
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
          <Stat label="Orders shipped whole" value={num(r.ordersFull)} sub={`${pct(r.ordersFull, totals.orders)}% of ${num(totals.orders)}`} flag={best.orders} />
          <Stat label="Part-filled" value={num(r.ordersPartial)} sub={`${num(r.ordersUntouched)} untouched`} />
          <Stat label="Units out" value={num(r.unitsShipped)} sub={`${num(r.unitsFromGallatin)} Gallatin · ${num(r.unitsFromUtah)} Utah`} />
          <Stat label="Value released" value={money(r.valueShipped)} sub={`${pct(r.valueShipped, totals.value)}% of ${money(totals.value)}`} flag={best.value} />
        </div>

        <div>
          <div className="text-xs font-semibold text-gray-500 mb-1">Which store gets served</div>
          <div className="overflow-x-auto">
            <table className="data-table text-sm">
              <thead><tr><th>Store</th><th>Whole</th><th>Part</th><th>Units</th><th>Value</th></tr></thead>
              <tbody>
                <tr>
                  <td><span className="badge badge-purple">Beast</span></td>
                  <td>{num(r.byStore.beast.ordersFull)}</td><td>{num(r.byStore.beast.ordersPartial)}</td>
                  <td>{num(r.byStore.beast.units)}</td><td>{money(r.byStore.beast.value)}</td>
                </tr>
                <tr>
                  <td><span className="badge badge-blue">Archery</span></td>
                  <td>{num(r.byStore.archery.ordersFull)}</td><td>{num(r.byStore.archery.ordersPartial)}</td>
                  <td>{num(r.byStore.archery.units)}</td><td>{money(r.byStore.archery.value)}</td>
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
  const { user, data, error, kinds, location, storeFilter, customers, scenarios, scenario } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";

  const results = data?.results ?? [];
  const [focus, setFocus] = useState<StrategyKind | null>(null);
  const [openOrder, setOpenOrder] = useState<string | null>(null);
  const shown = (focus && results.find((r) => r.kind === focus)) || results[0];

  const bestOrders = Math.max(0, ...results.map((r) => r.ordersFull));
  const bestValue = Math.max(0, ...results.map((r) => r.valueShipped));
  const totals = { orders: data?.totalOrders ?? 0, units: data?.totalUnits ?? 0, value: data?.totalValue ?? 0 };

  const ad = actionData && typeof actionData === "object" ? (actionData as Record<string, any>) : null;
  if (ad && ad.savedId && typeof window !== "undefined") {
    const want = `/fulfillment-compare?scenario=${ad.savedId}`;
    if (!window.location.search.includes(ad.savedId)) window.location.href = want;
  }

  // Shared inputs, repeated in each form so every button acts on what's on screen.
  const InputsAsHidden = () => (
    <>
      <input type="hidden" name="location" value={location} />
      <input type="hidden" name="store" value={storeFilter} />
      <input type="hidden" name="customers" value={customers} />
      {kinds.map((k) => <input key={k} type="hidden" name="s" value={k} />)}
    </>
  );

  return (
    <Layout user={user}>
      <div className="page-header flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">Compare fulfillment strategies</h1>
          <p className="page-subtitle">
            Same backlog, same stock, different ways of handing it out. See what each approach clears, where the
            units come from, and what you'd still need to buy or build.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Link to="/unfulfilled" className="btn btn-secondary btn-sm">Unfulfilled orders</Link>
          <Link to="/fulfillment-plans" className="btn btn-secondary btn-sm">Game plans</Link>
        </div>
      </div>

      {error && <div className="alert alert-error mb-4">Couldn't run the comparison: {error}</div>}
      {ad?.error && <div className="alert alert-error mb-4">{ad.error}</div>}
      {ad?.message && <div className="alert alert-success mb-4">{ad.message}</div>}

      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        {/* Saved scenarios */}
        <div>
          <div className="card">
            <div className="card-header !py-3"><span className="text-sm font-semibold">Saved scenarios</span></div>
            <div className="max-h-[50vh] overflow-y-auto">
              {scenarios.length === 0 ? (
                <p className="text-sm text-gray-500 px-4 py-5">None yet. Set up a comparison and save it.</p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {scenarios.map((sc) => (
                    <li key={sc.id} className={`px-4 py-3 group ${scenario?.id === sc.id ? "bg-beast-50" : ""}`}>
                      <div className="flex items-start justify-between gap-2">
                        <Link to={`/fulfillment-compare?scenario=${sc.id}`} className="min-w-0 flex-1">
                          <p className={`text-sm truncate ${scenario?.id === sc.id ? "font-medium text-beast-800" : "text-gray-800"}`}>{sc.name}</p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {sc.location === "EITHER" ? "Either site" : sc.location === "UTAH" ? "Utah" : "Gallatin"} ·{" "}
                            {sc.count} {sc.count === 1 ? "strategy" : "strategies"}
                          </p>
                        </Link>
                        <Form method="post" onSubmit={(e) => { if (!confirm(`Delete "${sc.name}"?`)) e.preventDefault(); }}>
                          <input type="hidden" name="intent" value="delete" />
                          <input type="hidden" name="scenarioId" value={sc.id} />
                          <button className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600 text-xs">Delete</button>
                        </Form>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>

        <div>
          <Form method="get" className="card mb-4">
            {scenario && <input type="hidden" name="scenario" value={scenario.id} />}
            <div className="card-body space-y-3">
              <div className="grid gap-3 md:grid-cols-3">
                <div>
                  <label className="form-label">Ship from</label>
                  <select name="location" defaultValue={location} className="form-select">
                    <option value="GALLATIN">Gallatin</option>
                    <option value="UTAH">Utah</option>
                    <option value="EITHER">Either — Gallatin first, Utah for the rest</option>
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
                  <input name="customers" defaultValue={customers} placeholder="Lancaster, Sportsman's…" className="form-input" />
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

          {/* Save / save-as, acting on whatever is currently on screen */}
          <Form method="post" className="card mb-4">
            <div className="card-body flex flex-wrap items-end gap-2">
              <InputsAsHidden />
              <div className="flex-1 min-w-[200px]">
                <label className="form-label">Scenario name</label>
                <input name="name" defaultValue={scenario?.name ?? ""} placeholder="e.g. October — Gallatin, whole first" className="form-input" />
              </div>
              {scenario && <input type="hidden" name="scenarioId" value={scenario.id} />}
              <button name="intent" value={scenario ? "save" : "save-as"} className="btn btn-primary" disabled={busy}>
                {scenario ? "Save changes" : "Save scenario"}
              </button>
              {scenario && (
                <button name="intent" value="save-as" className="btn btn-secondary" disabled={busy}>Save as new</button>
              )}
            </div>
          </Form>

          {data && (
            <>
              <p className="text-sm text-gray-600 mb-3">
                Backlog: <strong>{num(data.totalOrders)}</strong> orders · <strong>{num(data.totalUnits)}</strong> units ·{" "}
                <strong>{money(data.totalValue)}</strong> — every strategy starts from the same stock at{" "}
                {location === "EITHER" ? "both sites" : location === "UTAH" ? "Utah" : "Gallatin"}.
              </p>

              <div className="grid gap-4 2xl:grid-cols-2 mb-6">
                {results.map((r) => (
                  <StrategyCard
                    key={r.kind}
                    r={r}
                    totals={totals}
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

              {shown && (
                <>
                  <div className="card mb-4">
                    <div className="card-header flex-wrap gap-2">
                      <span className="card-title">Detail for one strategy</span>
                      <select
                        value={shown.kind}
                        onChange={(e) => { setFocus(e.target.value as StrategyKind); setOpenOrder(null); }}
                        className="form-select"
                        style={{ maxWidth: 300 }}
                      >
                        {results.map((r) => <option key={r.kind} value={r.kind}>{r.label}</option>)}
                      </select>
                    </div>
                  </div>

                  {/* Where each SKU's units come from */}
                  <Accordion
                    title="Units by SKU and warehouse"
                    summary={`${num(shown.bySku.length)} SKUs · ${num(shown.unitsFromGallatin)} Gallatin / ${num(shown.unitsFromUtah)} Utah`}
                  >
                    <div>
                      <p className="text-sm text-gray-600 mb-3">
                        {num(shown.unitsFromGallatin)} units would come out of Gallatin and {num(shown.unitsFromUtah)} out
                        of Utah under <strong>{shown.label.toLowerCase()}</strong>.
                      </p>
                      <div className="overflow-x-auto">
                        <table className="data-table">
                          <thead><tr><th>SKU</th><th>Product</th><th>From Gallatin</th><th>From Utah</th><th>Total out</th><th>Still short</th></tr></thead>
                          <tbody>
                            {shown.bySku.length === 0 && (
                              <tr><td colSpan={6} className="text-center text-gray-500 py-6">Nothing to ship.</td></tr>
                            )}
                            {shown.bySku.map((r) => (
                              <tr key={r.sku}>
                                <td className="font-mono text-xs">{r.sku}</td>
                                <td>{r.title}</td>
                                <td>{num(r.fromGallatin)}</td>
                                <td>{num(r.fromUtah)}</td>
                                <td className="font-medium">{num(r.total)}</td>
                                <td className={r.stillShort > 0 ? "text-red-600" : "text-gray-400"}>{r.stillShort > 0 ? num(r.stillShort) : "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </Accordion>

                  {/* Every order in the scenario */}
                  <Accordion
                    title="Every order in this scenario"
                    summary={`${num(shown.orders.length)} orders · ${num(shown.ordersFull)} complete, ${num(shown.ordersPartial)} part, ${num(shown.ordersUntouched)} none`}
                  >
                    <div>
                      <div className="mb-3">
                        <a
                          className="btn btn-primary btn-sm"
                          href={`/fulfillment-compare/export?kind=${shown.kind}&location=${location}&store=${encodeURIComponent(storeFilter)}&customers=${encodeURIComponent(customers)}&name=${encodeURIComponent(scenario?.name ?? "Scenario")}`}
                        >
                          Export CSV
                        </a>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th></th><th>Order</th><th>Store</th><th>Customer</th><th>Waiting</th>
                              <th>Needed</th><th>Shipping</th><th>Gallatin</th><th>Utah</th><th>Ships from</th><th>Outcome</th>
                            </tr>
                          </thead>
                          <tbody>
                            {shown.orders.map((o) => {
                              const key = `${o.store}:${o.orderName}`;
                              return [
                                <tr key={key} onClick={() => setOpenOrder(openOrder === key ? null : key)} className="cursor-pointer">
                                  <td className="text-gray-400">{o.lines.length ? (openOrder === key ? "▾" : "▸") : ""}</td>
                                  <td className="font-medium">{o.orderName}</td>
                                  <td><span className={`badge ${o.store === "beast" ? "badge-purple" : "badge-blue"}`}>{o.store === "beast" ? "Beast" : "Archery"}</span></td>
                                  <td>{o.customer || "—"}</td>
                                  <td className={o.ageDays > 14 ? "text-red-600" : ""}>{o.ageDays}d</td>
                                  <td>{num(o.needed)}</td>
                                  <td className="font-medium">{num(o.shipped)}</td>
                                  <td>{o.fromGallatin ? num(o.fromGallatin) : "—"}</td>
                                  <td>{o.fromUtah ? num(o.fromUtah) : "—"}</td>
                                  <td><span className={`badge ${SOURCE_CLASS[o.source]}`}>{SOURCE_LABEL[o.source]}</span></td>
                                  <td>
                                    <span className={`badge ${o.outcome === "FULL" ? "badge-green" : o.outcome === "PARTIAL" ? "badge-yellow" : "badge-gray"}`}>
                                      {o.outcome === "FULL" ? "Ships complete" : o.outcome === "PARTIAL" ? "Part-fills" : "Nothing available"}
                                    </span>
                                  </td>
                                </tr>,
                                openOrder === key && o.lines.length > 0 && (
                                  <tr key={`${key}-x`}>
                                    <td></td>
                                    <td colSpan={10} className="bg-gray-50">
                                      <div className="overflow-x-auto py-2">
                                        <table className="data-table text-sm">
                                          <thead><tr><th>SKU</th><th>Product</th><th>Needed</th><th>From Gallatin</th><th>From Utah</th></tr></thead>
                                          <tbody>
                                            {o.lines.map((l, i) => (
                                              <tr key={i}>
                                                <td className="font-mono text-xs">{l.sku}</td><td>{l.title}</td>
                                                <td>{num(l.needed)}</td><td>{num(l.fromGallatin)}</td><td>{num(l.fromUtah)}</td>
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
                  </Accordion>

                  {/* Buy / build list */}
                  <div className="card">
                    <div className="card-header"><span className="card-title">What's still needed to clear the rest</span></div>
                    <div className="card-body">
                      <p className="text-sm text-gray-600 mb-3">
                        Once <strong>{shown.label.toLowerCase()}</strong> has taken its pass, this is what you'd have to buy
                        or build to finish every remaining order: <strong>{num(shown.shortfallUnits)}</strong> units across{" "}
                        <strong>{num(shown.shortfall.length)}</strong> SKUs.
                      </p>
                      <div className="overflow-x-auto">
                        <table className="data-table">
                          <thead><tr><th>SKU</th><th>Product</th><th>Still needed</th><th>Orders waiting on it</th></tr></thead>
                          <tbody>
                            {shown.shortfall.length === 0 && (
                              <tr><td colSpan={4} className="text-center text-gray-500 py-6">Nothing — this strategy clears the whole backlog.</td></tr>
                            )}
                            {shown.shortfall.map((r) => (
                              <tr key={r.sku}>
                                <td className="font-mono text-xs">{r.sku}</td><td>{r.title}</td>
                                <td className="font-medium text-red-600">{num(r.stillNeeded)}</td><td>{num(r.ordersWaiting)}</td>
                              </tr>
                            ))}
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
