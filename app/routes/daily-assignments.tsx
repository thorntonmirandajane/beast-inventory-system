import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation, useSubmit } from "react-router";
import { useState } from "react";
import { requireRole, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { computeDailyPlan } from "../utils/planning.server";
import { assignWork } from "../utils/assignments";

function ymd(d: Date) {
  return d.toISOString().split("T")[0];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN", "MANAGER"]);
  const url = new URL(request.url);
  const dateParam = url.searchParams.get("date");

  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const target = dateParam ? new Date(`${dateParam}T12:00:00`) : tomorrow;
  target.setHours(12, 0, 0, 0);

  const demandFrom = new Date();
  const demandTo = new Date(target.getTime() + 30 * 24 * 60 * 60 * 1000);

  const plan = await computeDailyPlan(target, demandFrom, demandTo);
  const result = assignWork(plan.queue, plan.workers);

  const allWorkers = await prisma.user.findMany({
    where: { isActive: true },
    select: { id: true, firstName: true, lastName: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  return {
    user,
    date: ymd(target),
    result,
    workers: plan.workers,
    allWorkers,
    warnings: plan.warnings,
    pendingApplied: plan.pendingApplied,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN", "MANAGER"]);
  const formData = await request.formData();
  const dateStr = formData.get("date") as string;
  const rowsJson = formData.get("rows") as string;

  let rows: { userId: string; processName: string; skuId: string; units: number }[] = [];
  try {
    rows = JSON.parse(rowsJson || "[]");
  } catch {
    return { error: "Could not read the assignment rows." };
  }
  const valid = rows.filter((r) => r.userId && r.processName && r.skuId && r.units > 0);
  if (valid.length === 0) return { error: "Nothing to assign." };

  const dueDate = new Date(`${dateStr}T12:00:00`);
  let created = 0;
  for (const r of valid) {
    await prisma.workerTask.create({
      data: {
        userId: r.userId,
        processName: r.processName,
        skuId: r.skuId,
        targetQuantity: Math.round(r.units),
        assignmentType: "DAILY",
        status: "PENDING",
        assignedById: user.id,
        dueDate,
        notes: "Suggested daily assignment",
      },
    });
    created++;
  }
  await createAuditLog(user.id, "CREATE_DAILY_ASSIGNMENTS", "WorkerTask", "bulk", { created, date: dateStr });
  return { success: true, message: `Created ${created} assignment${created === 1 ? "" : "s"} for ${dateStr}.` };
};

export default function DailyAssignments() {
  const { user, date, result, workers, allWorkers, warnings, pendingApplied } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const busy = navigation.state !== "idle";

  // Editable rows initialized from the suggestion.
  const [rows, setRows] = useState(
    result.assignments.map((a, i) => ({ ...a, id: `${i}` }))
  );

  const nameById = new Map(allWorkers.map((w) => [w.id, `${w.firstName} ${w.lastName}`]));
  const setWorker = (id: string, userId: string) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, userId, name: nameById.get(userId) || r.name } : r)));
  const setUnits = (id: string, units: number) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, units } : r)));
  const removeRow = (id: string) => setRows((rs) => rs.filter((r) => r.id !== id));

  // Per-worker hour totals (from each row's suggested hours).
  const workerHours = new Map<string, number>();
  for (const r of rows) workerHours.set(r.userId, (workerHours.get(r.userId) ?? 0) + (r.hours || 0));

  const commit = () => {
    const payload = rows
      .filter((r) => r.userId && r.processName && r.skuId && r.units > 0)
      .map((r) => ({ userId: r.userId, processName: r.processName, skuId: r.skuId, units: r.units }));
    const fd = new FormData();
    fd.set("date", date);
    fd.set("rows", JSON.stringify(payload));
    submit(fd, { method: "post" });
  };

  return (
    <Layout user={user}>
      <div className="page-header flex items-start justify-between">
        <div>
          <h1 className="page-title">Daily Assignments</h1>
          <p className="page-subtitle">
            Suggested work for scheduled workers, from the forecast need. Reassign or adjust, then create.
          </p>
        </div>
        <Form method="get" className="flex items-end gap-2">
          <div className="form-group mb-0">
            <label className="form-label text-sm">For date</label>
            <input type="date" name="date" defaultValue={date} className="form-input" />
          </div>
          <button type="submit" className="btn btn-secondary">Generate</button>
        </Form>
      </div>

      {actionData && "error" in actionData && actionData.error && (
        <div className="alert alert-error mb-6">{actionData.error}</div>
      )}
      {actionData && "success" in actionData && actionData.success && (
        <div className="alert alert-success mb-6">{actionData.message}</div>
      )}
      {warnings.length > 0 && (
        <div className="alert alert-warning mb-6 whitespace-pre-line">{warnings.join("\n")}</div>
      )}

      <div className="text-sm text-gray-500 mb-4">
        Planning for <strong>{date}</strong> · {workers.length} worker(s) scheduled ·{" "}
        {pendingApplied} pending (un-QC'd) line(s) factored into stock.
      </div>

      {/* Suggested assignments (editable) */}
      <div className="card mb-6">
        <div className="card-header">
          <h2 className="card-title">Suggested Assignments ({rows.length})</h2>
          <button className="btn btn-primary btn-sm" onClick={commit} disabled={busy || rows.length === 0}>
            {busy ? "Saving…" : "Create Assignments"}
          </button>
        </div>
        <div className="card-body overflow-x-auto">
          {rows.length === 0 ? (
            <p className="text-gray-500 text-sm">No buildable work to assign for this date.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="py-2 pr-4">Worker</th>
                  <th className="py-2 pr-4">Process</th>
                  <th className="py-2 pr-4">SKU</th>
                  <th className="py-2 pr-4 text-right">Qty</th>
                  <th className="py-2 pr-4 text-right">~Hours</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-1 pr-4">
                      <select
                        value={r.userId}
                        onChange={(e) => setWorker(r.id, e.target.value)}
                        className="form-input py-1 text-sm"
                      >
                        {allWorkers.map((w) => (
                          <option key={w.id} value={w.id}>{w.firstName} {w.lastName}</option>
                        ))}
                      </select>
                    </td>
                    <td className="py-1 pr-4">{r.process}</td>
                    <td className="py-1 pr-4 font-mono">{r.sku}</td>
                    <td className="py-1 pr-4 text-right">
                      <input
                        type="number"
                        value={r.units}
                        min="0"
                        onChange={(e) => setUnits(r.id, parseInt(e.target.value, 10) || 0)}
                        className="form-input py-1 text-sm w-24 text-right"
                      />
                    </td>
                    <td className="py-1 pr-4 text-right text-gray-500">{(r.hours || 0).toFixed(1)}h</td>
                    <td className="py-1 text-right">
                      <button onClick={() => removeRow(r.id)} className="btn btn-ghost btn-sm text-red-600">Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Per-worker capacity */}
      {workers.length > 0 && (
        <div className="card mb-6">
          <div className="card-header"><h2 className="card-title">Scheduled Workers</h2></div>
          <div className="card-body text-sm">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              {workers.map((w) => {
                const used = workerHours.get(w.userId) ?? 0;
                return (
                  <div key={w.userId} className="flex justify-between border-b last:border-0 py-1">
                    <span>{w.name}</span>
                    <span className={used > w.hours + 1e-9 ? "text-red-600" : "text-gray-600"}>
                      {used.toFixed(1)}h / {w.hours.toFixed(1)}h
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Blocked work */}
      {result.blocked.length > 0 && (
        <div className="card mb-6">
          <div className="card-header"><h2 className="card-title">Blocked — needs an upstream stage first ({result.blocked.length})</h2></div>
          <div className="card-body text-sm">
            <table className="w-full">
              <thead>
                <tr className="text-left border-b">
                  <th className="py-2 pr-4">Process</th>
                  <th className="py-2 pr-4">SKU</th>
                  <th className="py-2 pr-4 text-right">Units</th>
                </tr>
              </thead>
              <tbody>
                {result.blocked.map((b, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-1 pr-4">{b.process}</td>
                    <td className="py-1 pr-4 font-mono">{b.sku}</td>
                    <td className="py-1 pr-4 text-right">{b.units.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Buildable but no capacity */}
      {result.unassigned.length > 0 && (
        <div className="alert alert-warning">
          {result.unassigned.length} buildable task(s) couldn't fit the scheduled hours — more capacity needed or carry to the next day.
        </div>
      )}
    </Layout>
  );
}
