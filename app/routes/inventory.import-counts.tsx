import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import { requireRole, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import { parseOpeningCountRows } from "../utils/counts";
import { applyOpeningCounts } from "../utils/inventory.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN", "MANAGER"]);
  return { user };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN", "MANAGER"]);

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "preview");

  // Prefer an uploaded file; fall back to the pasted textarea.
  const file = formData.get("csvFile") as File | null;
  let text = String(formData.get("counts") || "");
  if (file && file.size > 0) {
    text = await file.text();
  }

  if (!text.trim()) {
    return { error: "Paste some rows or choose a CSV file first." };
  }

  const { rows, errors } = parseOpeningCountRows(text);
  if (rows.length === 0) {
    return { error: "No SKU + quantity rows found.", parseErrors: errors };
  }

  const apply = intent === "apply";
  const result = await applyOpeningCounts(rows, user.id, { dryRun: !apply });

  if (apply) {
    const changed = result.items.filter((i) => i.delta !== 0).length;
    await createAuditLog(user.id, "IMPORT_OPENING_COUNTS", "InventoryItem", "bulk", {
      changed,
      unknown: result.unknownSkus.length,
    });
  }

  return { result, parseErrors: errors, applied: apply };
};

export default function ImportCounts() {
  const { user } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const result = actionData && "result" in actionData ? actionData.result : null;
  const changed = result ? result.items.filter((i) => i.delta !== 0) : [];

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Import / Spot-Check Counts</h1>
        <p className="page-subtitle">
          Paste or upload <strong>SKU, quantity</strong> rows. This SETS the on-hand count
          for each SKU (state is inferred from the SKU type) and logs an adjustment. Use it
          to seed the opening hard count and for weekly spot-checks.
        </p>
      </div>

      {actionData && "error" in actionData && actionData.error && (
        <div className="alert alert-error">{actionData.error}</div>
      )}

      {actionData?.applied && result && (
        <div className="alert alert-success">
          Applied {changed.length} count change{changed.length === 1 ? "" : "s"}
          {result.unknownSkus.length > 0 ? `, ${result.unknownSkus.length} unknown SKU(s) skipped` : ""}.
        </div>
      )}

      <div className="card mb-6">
        <div className="card-body">
          <Form method="post" encType="multipart/form-data">
            <div className="form-group">
              <label htmlFor="counts" className="form-label">
                Paste rows (one per line: SKU, quantity)
              </label>
              <textarea
                id="counts"
                name="counts"
                className="form-input font-mono text-sm"
                rows={10}
                placeholder={"BLADE-2IN, 33460\nTIPPED-FERRULE, 1920\n3PACK-100g-2.0in, 3489"}
              />
            </div>
            <div className="form-group">
              <label htmlFor="csvFile" className="form-label">
                …or upload a CSV (overrides the paste box)
              </label>
              <input id="csvFile" type="file" name="csvFile" accept=".csv,text/csv" className="form-input" />
            </div>
            <div className="flex gap-3">
              <button
                type="submit"
                name="intent"
                value="preview"
                className="btn btn-secondary"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Working…" : "Preview"}
              </button>
              <button
                type="submit"
                name="intent"
                value="apply"
                className="btn btn-primary"
                disabled={isSubmitting}
                onClick={(e) => {
                  if (!confirm("Set on-hand counts to these values? This overwrites the current counts for the listed SKUs.")) {
                    e.preventDefault();
                  }
                }}
              >
                {isSubmitting ? "Working…" : "Apply Counts"}
              </button>
            </div>
          </Form>
        </div>
      </div>

      {actionData?.parseErrors && actionData.parseErrors.length > 0 && (
        <div className="alert alert-error whitespace-pre-line mb-6">
          {actionData.parseErrors.join("\n")}
        </div>
      )}

      {result && (
        <>
          {result.unknownSkus.length > 0 && (
            <div className="alert alert-error mb-6">
              <strong>{result.unknownSkus.length} unknown SKU(s)</strong> (skipped — check spelling or
              create the SKU first): {result.unknownSkus.join(", ")}
            </div>
          )}
          {result.warnings.length > 0 && (
            <div className="alert alert-warning whitespace-pre-line mb-6">
              {result.warnings.join("\n")}
            </div>
          )}

          <div className="card">
            <div className="card-header">
              <h2 className="card-title">
                {actionData?.applied ? "Applied" : "Preview"} — {result.items.length} matched SKU(s),
                {" "}{changed.length} changing
              </h2>
            </div>
            <div className="card-body overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b">
                    <th className="py-2 pr-4">SKU</th>
                    <th className="py-2 pr-4">Name</th>
                    <th className="py-2 pr-4">State</th>
                    <th className="py-2 pr-4 text-right">Current</th>
                    <th className="py-2 pr-4 text-right">New</th>
                    <th className="py-2 pr-4 text-right">Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {result.items.map((item) => (
                    <tr key={item.sku} className="border-b last:border-0">
                      <td className="py-1 pr-4 font-mono">{item.sku}</td>
                      <td className="py-1 pr-4">{item.name}</td>
                      <td className="py-1 pr-4">{item.state}</td>
                      <td className="py-1 pr-4 text-right">{item.current.toLocaleString()}</td>
                      <td className="py-1 pr-4 text-right">{item.newQty.toLocaleString()}</td>
                      <td
                        className={
                          "py-1 pr-4 text-right font-medium " +
                          (item.delta > 0 ? "text-green-600" : item.delta < 0 ? "text-red-600" : "text-gray-400")
                        }
                      >
                        {item.delta > 0 ? "+" : ""}
                        {item.delta.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </Layout>
  );
}
