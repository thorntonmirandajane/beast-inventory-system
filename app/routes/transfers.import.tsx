import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation, useSubmit, Link } from "react-router";
import { useState, useEffect } from "react";
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
  const destination = ((formData.get("destination") as string) || "").trim() || "Fulfillment Center";
  const dateStr = formData.get("transferDate") as string;

  if (intent === "process-rows") {
    let parsed: { skuId: string; quantity: number }[] = [];
    try {
      parsed = JSON.parse((formData.get("rows") as string) || "[]");
    } catch {
      return { error: "Couldn't read the edited rows — re-preview and try again." };
    }
    const valid = parsed.filter((r) => r.skuId && r.quantity > 0);
    if (valid.length === 0) return { error: "Nothing to process — every row was removed or zero." };

    const skus = await prisma.sku.findMany({
      where: { id: { in: valid.map((r) => r.skuId) } },
      select: { id: true, sku: true, type: true },
    });
    const byId = new Map(skus.map((s) => [s.id, s]));
    for (const r of valid) {
      const s = byId.get(r.skuId);
      if (!s) return { error: "A SKU is no longer valid — re-preview." };
      if (s.type !== "COMPLETED") return { error: `${s.sku} is not a completed product.` };
    }

    const transfer = await prisma.transfer.create({
      data: {
        destination,
        shippedAt: dateStr ? new Date(`${dateStr}T12:00:00`) : new Date(),
        notes: "CSV import",
        createdById: user.id,
        items: { create: valid.map((r) => ({ skuId: r.skuId, quantity: r.quantity })) },
      },
    });
    for (const r of valid) {
      await deductInventory(r.skuId, r.quantity, ["COMPLETED"], transfer.id, "Transfer");
    }
    await createAuditLog(user.id, "IMPORT_TRANSFER", "Transfer", transfer.id, {
      destination,
      items: valid.length,
      totalQty: valid.reduce((s, r) => s + r.quantity, 0),
    });
    return { processed: true, destination, processedCount: valid.length };
  }

  // ---- preview ----
  const file = formData.get("csvFile") as File | null;
  let text = String(formData.get("csv") || "");
  if (file && file.size > 0) text = await file.text();
  if (!text.trim()) return { error: "Upload a CSV or paste rows first." };

  const rows: { sku: string; qty: number }[] = [];
  const parseErrors: string[] = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) return;
    const cells = line.split(",").map((c) => c.trim());
    if (idx === 0 && /sku/i.test(cells[0] || "")) return;
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
      items.push({ sku: r.sku, name: "—", type: "—", requested: r.qty, current: 0, status: "not-found" });
      continue;
    }
    if (sku.type !== "COMPLETED") {
      items.push({ skuId: sku.id, sku: sku.sku, name: sku.name, type: sku.type, requested: r.qty, current: 0, status: "not-completed" });
      continue;
    }
    const current = await getAvailableQuantity(sku.id, ["COMPLETED"]);
    items.push({ skuId: sku.id, sku: sku.sku, name: sku.name, type: sku.type, requested: r.qty, current, status: current - r.qty < 0 ? "short" : "ok" });
  }

  return { items, parseErrors };
};

type EditRow = {
  id: string;
  skuId?: string;
  sku: string;
  name: string;
  current: number;
  requested: number;
  found: boolean;
  completed: boolean;
};

export default function TransfersImport() {
  const { user, today } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const busy = navigation.state !== "idle";

  const [rows, setRows] = useState<EditRow[]>([]);
  const [destination, setDestination] = useState("Gallatin Fulfillment");
  const [transferDate, setTransferDate] = useState(today);

  const processed = !!(actionData && "processed" in actionData && actionData.processed);

  // Load the editable table from a fresh preview.
  useEffect(() => {
    if (processed) {
      setRows([]);
      return;
    }
    if (actionData && "items" in actionData && actionData.items) {
      setRows(
        actionData.items.map((it, i) => ({
          id: `${i}`,
          skuId: it.skuId,
          sku: it.sku,
          name: it.name,
          current: it.current,
          requested: it.requested,
          found: it.status !== "not-found",
          completed: it.status === "ok" || it.status === "short",
        }))
      );
    }
  }, [actionData, processed]);

  const setQty = (id: string, v: string) => {
    const n = parseInt(v, 10);
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, requested: isNaN(n) ? 0 : n } : r)));
  };
  const removeRow = (id: string) => setRows((rs) => rs.filter((r) => r.id !== id));

  const rowStatus = (r: EditRow): { label: string; color: string } => {
    if (!r.found) return { label: "SKU not found — delete", color: "#ef4444" };
    if (!r.completed) return { label: "Not a completed product — delete", color: "#ef4444" };
    if (r.requested <= 0) return { label: "0 — will skip", color: "#9ca3af" };
    const after = r.current - r.requested;
    return after < 0 ? { label: "Goes negative", color: "#ef4444" } : { label: "OK", color: "#16a34a" };
  };

  const processable = rows.filter((r) => r.found && r.completed && r.skuId && r.requested > 0);
  const blockers = rows.filter((r) => !r.found || !r.completed);
  const totalUnits = processable.reduce((s, r) => s + r.requested, 0);

  const process = () => {
    if (processable.length === 0) return;
    if (!confirm(`Process ${processable.length} item(s) (${totalUnits.toLocaleString()} units) to ${destination}? This deducts them from finished-goods on-hand.`)) return;
    const fd = new FormData();
    fd.set("intent", "process-rows");
    fd.set("destination", destination);
    fd.set("transferDate", transferDate);
    fd.set("rows", JSON.stringify(processable.map((r) => ({ skuId: r.skuId, quantity: r.requested }))));
    submit(fd, { method: "post" });
  };

  return (
    <Layout user={user}>
      <div className="page-header flex items-start justify-between">
        <div>
          <h1 className="page-title">Import Transfer (CSV)</h1>
          <p className="page-subtitle">
            Upload what was shipped (<strong>SKU, Quantity</strong>). Preview, then edit quantities or delete rows
            before processing — it deducts the units from finished-goods on-hand.
          </p>
        </div>
        <Link to="/transfers" className="btn btn-ghost">← Transfers</Link>
      </div>

      {actionData && "error" in actionData && actionData.error && (
        <div className="alert alert-error mb-4">{actionData.error}</div>
      )}
      {processed && actionData && "processedCount" in actionData && (
        <div className="alert alert-success mb-4">
          Transfer processed — {actionData.processedCount} item(s) deducted and shipped to{" "}
          <strong>{actionData.destination}</strong>.
        </div>
      )}

      <div className="card mb-6">
        <div className="card-body">
          <Form method="post" encType="multipart/form-data" className="space-y-4">
            <input type="hidden" name="intent" value="preview" />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="form-group mb-0">
                <label className="form-label">Destination</label>
                <input type="text" name="destination" value={destination} onChange={(e) => setDestination(e.target.value)} className="form-input" />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Transfer date</label>
                <input type="date" name="transferDate" value={transferDate} onChange={(e) => setTransferDate(e.target.value)} className="form-input" />
              </div>
            </div>
            <div className="form-group">
              <label htmlFor="csvFile" className="form-label">CSV file (SKU, Quantity)</label>
              <input id="csvFile" type="file" name="csvFile" accept=".csv,text/csv" className="form-input" />
            </div>
            <div className="form-group">
              <label htmlFor="csv" className="form-label">…or paste rows (SKU, quantity)</label>
              <textarea id="csv" name="csv" rows={5} className="form-input font-mono text-sm"
                placeholder={"3PACK-100g-2.0in, 1900\n2PACK-125g-2.0in, 400"} />
            </div>
            <button type="submit" className="btn btn-secondary" disabled={busy}>
              {busy ? "Working…" : "Preview"}
            </button>
          </Form>
        </div>
      </div>

      {actionData && "parseErrors" in actionData && actionData.parseErrors && actionData.parseErrors.length > 0 && (
        <div className="alert alert-warning whitespace-pre-line mb-4">{actionData.parseErrors.join("\n")}</div>
      )}

      {rows.length > 0 && (
        <div className="card">
          <div className="card-header flex items-center justify-between">
            <h2 className="card-title">Review & edit — {rows.length} row(s)</h2>
            <span className="text-sm text-gray-500">
              {processable.length} ready · {totalUnits.toLocaleString()} units
              {blockers.length > 0 && <span className="text-red-600"> · {blockers.length} to delete</span>}
            </span>
          </div>
          <div className="card-body overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Name</th>
                  <th className="text-right">Shipped (edit)</th>
                  <th className="text-right">On hand</th>
                  <th className="text-right">After</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const st = rowStatus(r);
                  const after = r.current - r.requested;
                  const editable = r.found && r.completed;
                  return (
                    <tr key={r.id} style={!editable || after < 0 ? { background: "#fef2f2" } : undefined}>
                      <td className="font-mono text-sm">{r.sku}</td>
                      <td className="text-sm">{r.name}</td>
                      <td className="text-right">
                        {editable ? (
                          <input
                            type="number"
                            min="0"
                            value={r.requested}
                            onChange={(e) => setQty(r.id, e.target.value)}
                            className="form-input text-sm py-1 px-2 w-24 text-right"
                          />
                        ) : (
                          <span className="text-gray-400">{r.requested.toLocaleString()}</span>
                        )}
                      </td>
                      <td className="text-right">{editable ? r.current.toLocaleString() : "—"}</td>
                      <td className="text-right" style={editable && after < 0 ? { color: "#ef4444", fontWeight: 600 } : undefined}>
                        {editable ? after.toLocaleString() : "—"}
                      </td>
                      <td className="text-sm" style={{ color: st.color, fontWeight: st.label === "OK" ? 400 : 600 }}>{st.label}</td>
                      <td className="text-right">
                        <button onClick={() => removeRow(r.id)} className="btn btn-sm btn-ghost text-red-600">Delete</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="mt-4 pt-4 border-t flex items-center gap-3">
              <button onClick={process} className="btn btn-primary" disabled={busy || processable.length === 0}>
                {busy ? "Working…" : `Process Transfer (${processable.length})`}
              </button>
              <span className="text-xs text-gray-500">
                Delete the rows you can't ship, adjust quantities, then process. Only valid, completed rows with a
                quantity above 0 are included.
              </span>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}
