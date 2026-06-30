import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation, Link } from "react-router";
import { requireRole, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { getAvailableQuantity, deductInventory } from "../utils/inventory.server";

const norm = (s: string) => s.trim().toUpperCase();

type PreviewItem = {
  skuId?: string;
  sku: string;
  name: string;
  type: string;
  requested: number;
  current: number;
  after: number;
  status: "ok" | "short" | "not-found" | "not-completed";
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN", "MANAGER"]);
  return { user, today: new Date().toISOString().split("T")[0] };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN", "MANAGER"]);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "preview");

  const file = formData.get("csvFile") as File | null;
  let text = String(formData.get("csv") || "");
  if (file && file.size > 0) text = await file.text();
  if (!text.trim()) return { error: "Upload a CSV or paste rows first." };

  const destination = ((formData.get("destination") as string) || "").trim() || "Fulfillment Center";
  const dateStr = formData.get("transferDate") as string;

  // Parse: SKU, Quantity (header row skipped).
  const rows: { sku: string; qty: number }[] = [];
  const parseErrors: string[] = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) return;
    const cells = line.split(",").map((c) => c.trim());
    if (idx === 0 && /sku/i.test(cells[0] || "")) return; // header
    const sku = cells[0];
    const qty = parseInt(cells[1], 10);
    if (!sku || isNaN(qty) || qty <= 0) {
      parseErrors.push(`Line ${idx + 1}: couldn't read "${line}"`);
      return;
    }
    rows.push({ sku, qty });
  });
  if (rows.length === 0) return { error: "No SKU + quantity rows found.", parseErrors };

  const skus = await prisma.sku.findMany({
    where: { isActive: true },
    select: { id: true, sku: true, name: true, type: true },
  });
  const byNorm = new Map(skus.map((s) => [norm(s.sku), s]));

  const items: PreviewItem[] = [];
  for (const r of rows) {
    const sku = byNorm.get(norm(r.sku));
    if (!sku) {
      items.push({ sku: r.sku, name: "—", type: "—", requested: r.qty, current: 0, after: 0, status: "not-found" });
      continue;
    }
    if (sku.type !== "COMPLETED") {
      items.push({ skuId: sku.id, sku: sku.sku, name: sku.name, type: sku.type, requested: r.qty, current: 0, after: 0, status: "not-completed" });
      continue;
    }
    const current = await getAvailableQuantity(sku.id, ["COMPLETED"]);
    const after = current - r.qty;
    items.push({ skuId: sku.id, sku: sku.sku, name: sku.name, type: sku.type, requested: r.qty, current, after, status: after < 0 ? "short" : "ok" });
  }

  const problems = items.filter((i) => i.status === "not-found" || i.status === "not-completed");
  const totalReq = items.reduce((s, i) => s + i.requested, 0);

  if (intent === "process") {
    if (problems.length > 0) {
      return { items, parseErrors, totalReq, error: `Fix ${problems.length} row(s) first — not found or not a completed product. Nothing was deducted.` };
    }
    const valid = items.filter((i) => i.skuId);
    const transfer = await prisma.transfer.create({
      data: {
        destination,
        shippedAt: dateStr ? new Date(`${dateStr}T12:00:00`) : new Date(),
        notes: "CSV import",
        createdById: user.id,
        items: { create: valid.map((i) => ({ skuId: i.skuId!, quantity: i.requested })) },
      },
    });
    for (const i of valid) {
      await deductInventory(i.skuId!, i.requested, ["COMPLETED"], transfer.id, "Transfer");
    }
    await createAuditLog(user.id, "IMPORT_TRANSFER", "Transfer", transfer.id, {
      destination,
      items: valid.length,
      totalQty: valid.reduce((s, i) => s + i.requested, 0),
    });
    return { items, parseErrors, totalReq, processed: true, destination };
  }

  return { items, parseErrors, totalReq, processed: false };
};

export default function TransfersImport() {
  const { user, today } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const items = actionData && "items" in actionData ? actionData.items : null;
  const totalReq = (actionData && "totalReq" in actionData ? actionData.totalReq : 0) ?? 0;
  const processed = !!(actionData && "processed" in actionData && actionData.processed);
  const shorts = items ? items.filter((i) => i.status === "short").length : 0;
  const problems = items ? items.filter((i) => i.status === "not-found" || i.status === "not-completed").length : 0;

  const statusBadge = (s: PreviewItem["status"]) => {
    if (s === "ok") return <span className="text-green-600">OK</span>;
    if (s === "short") return <span className="text-red-600 font-semibold">Goes negative</span>;
    if (s === "not-found") return <span className="text-red-600 font-semibold">SKU not found</span>;
    return <span className="text-red-600 font-semibold">Not a completed product</span>;
  };

  return (
    <Layout user={user}>
      <div className="page-header flex items-start justify-between">
        <div>
          <h1 className="page-title">Import Transfer (CSV)</h1>
          <p className="page-subtitle">
            Upload what was shipped (<strong>SKU, Quantity</strong>). Preview to verify, then process —
            it deducts the units from finished-goods (COMPLETED) on-hand.
          </p>
        </div>
        <Link to="/transfers" className="btn btn-ghost">← Transfers</Link>
      </div>

      {actionData && "error" in actionData && actionData.error && (
        <div className="alert alert-error mb-4">{actionData.error}</div>
      )}
      {actionData && "processed" in actionData && actionData.processed && (
        <div className="alert alert-success mb-4">
          Transfer processed to <strong>{actionData.destination}</strong> — inventory deducted.
        </div>
      )}

      <div className="card mb-6">
        <div className="card-body">
          <Form method="post" encType="multipart/form-data" className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="form-group mb-0">
                <label className="form-label">Destination</label>
                <input type="text" name="destination" defaultValue="Gallatin Fulfillment" className="form-input" />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Transfer date</label>
                <input type="date" name="transferDate" defaultValue={today} className="form-input" />
              </div>
            </div>
            <div className="form-group">
              <label htmlFor="csvFile" className="form-label">CSV file (SKU, Quantity)</label>
              <input id="csvFile" type="file" name="csvFile" accept=".csv,text/csv" className="form-input" />
            </div>
            <div className="form-group">
              <label htmlFor="csv" className="form-label">…or paste rows (SKU, quantity)</label>
              <textarea id="csv" name="csv" rows={6} className="form-input font-mono text-sm"
                placeholder={"3PACK-100g-2.0in, 1900\n2PACK-125g-2.0in, 400"} />
            </div>
            <div className="flex gap-3">
              <button type="submit" name="intent" value="preview" className="btn btn-secondary" disabled={busy}>
                {busy ? "Working…" : "Preview"}
              </button>
              <button
                type="submit"
                name="intent"
                value="process"
                className="btn btn-primary"
                disabled={busy}
                onClick={(e) => {
                  if (!confirm("Process this transfer? This deducts the listed quantities from finished-goods on-hand.")) e.preventDefault();
                }}
              >
                {busy ? "Working…" : "Process Transfer"}
              </button>
            </div>
          </Form>
        </div>
      </div>

      {actionData && "parseErrors" in actionData && actionData.parseErrors && actionData.parseErrors.length > 0 && (
        <div className="alert alert-warning whitespace-pre-line mb-4">{actionData.parseErrors.join("\n")}</div>
      )}

      {items && (
        <div className="card">
          <div className="card-header flex items-center justify-between">
            <h2 className="card-title">
              {processed ? "Processed" : "Preview"} — {items.length} row(s)
            </h2>
            <span className="text-sm text-gray-500">
              {totalReq.toLocaleString()} units
              {problems > 0 && <span className="text-red-600"> · {problems} problem(s)</span>}
              {shorts > 0 && <span className="text-red-600"> · {shorts} go negative</span>}
            </span>
          </div>
          <div className="card-body overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Name</th>
                  <th className="text-right">Shipped</th>
                  <th className="text-right">On hand now</th>
                  <th className="text-right">After</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i, idx) => (
                  <tr key={idx} style={i.status !== "ok" ? { background: "#fef2f2" } : undefined}>
                    <td className="font-mono text-sm">{i.sku}</td>
                    <td className="text-sm">{i.name}</td>
                    <td className="text-right">{i.requested.toLocaleString()}</td>
                    <td className="text-right">{i.status === "not-found" || i.status === "not-completed" ? "—" : i.current.toLocaleString()}</td>
                    <td className="text-right" style={i.after < 0 ? { color: "#ef4444", fontWeight: 600 } : undefined}>
                      {i.status === "not-found" || i.status === "not-completed" ? "—" : i.after.toLocaleString()}
                    </td>
                    <td className="text-sm">{statusBadge(i.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!processed && (
              <p className="text-xs text-gray-500 mt-3">
                Preview only — nothing has been deducted yet. "Goes negative" means you're shipping more than the
                current count (a count discrepancy to check). Found + completed rows still process.
              </p>
            )}
          </div>
        </div>
      )}
    </Layout>
  );
}
