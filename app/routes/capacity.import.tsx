import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation, Link } from "react-router";
import { requireRole, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { resolveProcessConfig } from "../utils/process";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN"]);
  return { user };
};

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) { values.push(current.trim()); current = ""; }
    else current += char;
  }
  values.push(current.trim());
  return values;
}

function deriveProcessName(displayName: string): string {
  return displayName.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "") || "PROCESS";
}

// Give a new process variant a sensible default time by inheriting from the
// longest base process whose name it starts with (e.g. "Stud Testing (2.3)" ->
// "Stud Testing"); fall back to 60s. Admin can adjust on the Process Times page.
function inheritSeconds(displayName: string, configs: { displayName: string; secondsPerUnit: number }[]): number {
  const pl = displayName.toLowerCase();
  let best = 0;
  let bestLen = 0;
  for (const c of configs) {
    const dl = c.displayName.toLowerCase();
    if (c.secondsPerUnit > 0 && pl.startsWith(dl) && dl.length > bestLen) {
      best = c.secondsPerUnit;
      bestLen = dl.length;
    }
  }
  return best || 60;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN"]);
  const formData = await request.formData();
  const csvFile = formData.get("csvFile") as File | null;
  if (!csvFile || csvFile.size === 0) return { error: "Please choose a CSV file." };

  const text = (await csvFile.text()).replace(/^﻿/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { error: "The CSV looks empty (no data rows)." };

  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const skuIdx = header.findIndex((h) => h.includes("sku"));
  const procIdx = header.findIndex((h) => h.includes("process") || h.includes("operation"));
  if (skuIdx === -1 || procIdx === -1) {
    return { error: 'Need a "SKU" column and a "Process" column.' };
  }

  type Cfg = { id: string; displayName: string; secondsPerUnit: number };
  let configs: Cfg[] = await prisma.processConfig.findMany({
    where: { isActive: true },
    select: { id: true, displayName: true, secondsPerUnit: true },
  });

  // SKU lookup, case-insensitive.
  const skuRows = await prisma.sku.findMany({ select: { id: true, sku: true } });
  const skuByCode = new Map<string, string>();
  for (const s of skuRows) skuByCode.set(s.sku.toUpperCase(), s.id);

  const rows = lines.slice(1).map((l) => parseCsvLine(l));
  const processesCreated: string[] = [];
  const assignments = new Map<string, string[]>(); // process displayName -> [skuId]
  const unknown: string[] = [];

  // 1) Ensure a ProcessConfig exists for every process named in the file.
  const uniqueProcesses = Array.from(
    new Set(rows.map((r) => (r[procIdx] || "").trim()).filter(Boolean))
  );
  for (const p of uniqueProcesses) {
    if (resolveProcessConfig(p, configs)) continue; // already have a matching process
    let processName = deriveProcessName(p);
    let n = 1;
    // ensure unique processName
    while (await prisma.processConfig.findUnique({ where: { processName } })) {
      n += 1;
      processName = `${deriveProcessName(p)}_${n}`;
    }
    const newCfg = await prisma.processConfig.create({
      data: {
        processName,
        displayName: p,
        secondsPerUnit: inheritSeconds(p, configs),
        isActive: true,
      },
      select: { id: true, displayName: true, secondsPerUnit: true },
    });
    configs.push(newCfg);
    processesCreated.push(`${p} (${newCfg.secondsPerUnit}s, adjust on Process Times)`);
  }

  // 2) Build per-process SKU assignment lists (store the canonical displayName).
  for (const r of rows) {
    const code = (r[skuIdx] || "").trim();
    const proc = (r[procIdx] || "").trim();
    if (!code || !proc) continue;
    const skuId = skuByCode.get(code.toUpperCase());
    if (!skuId) {
      unknown.push(code);
      continue;
    }
    const cfg = resolveProcessConfig(proc, configs); // always resolves now
    const display = cfg ? cfg.displayName : proc;
    const arr = assignments.get(display) ?? [];
    arr.push(skuId);
    assignments.set(display, arr);
  }

  // 3) Apply: set each SKU's material to its process display name.
  let assignedCount = 0;
  for (const [display, skuIds] of assignments) {
    await prisma.sku.updateMany({ where: { id: { in: skuIds } }, data: { material: display } });
    assignedCount += skuIds.length;
  }

  await createAuditLog(user.id, "IMPORT_PROCESS_ASSIGNMENTS", "Sku", "bulk", {
    assigned: assignedCount,
    processesCreated: processesCreated.length,
    unknown: unknown.length,
  });

  const summary = Array.from(assignments.entries())
    .map(([display, ids]) => `${display}: ${ids.length}`)
    .sort();

  return { success: true, assignedCount, processesCreated, unknown, summary };
};

export default function CapacityImport() {
  const { user } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const result = actionData && "success" in actionData ? actionData : null;
  const processesCreated = result?.processesCreated ?? [];
  const unknown = result?.unknown ?? [];
  const summary = result?.summary ?? [];

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Import Process Assignments</h1>
        <p className="page-subtitle">
          Assign each SKU to the process that builds it. New process names are created automatically.
        </p>
      </div>

      {actionData && "error" in actionData && actionData.error && (
        <div className="alert alert-error mb-6">{actionData.error}</div>
      )}

      {result && (
        <div className="alert alert-success mb-6">
          Assigned {result.assignedCount} SKU{result.assignedCount === 1 ? "" : "s"}
          {processesCreated.length > 0 ? `, created ${processesCreated.length} new process(es)` : ""}
          {unknown.length > 0 ? `, ${unknown.length} unknown SKU(s)` : ""}.
        </div>
      )}

      <div className="card mb-6">
        <div className="card-header"><h2 className="card-title">CSV format</h2></div>
        <div className="card-body text-sm text-gray-700 space-y-2">
          <p>
            A header row, then one row per SKU: a <strong>SKU</strong> column and a{" "}
            <strong>Process</strong> column. The process is matched to an existing one (e.g.
            "Completed Packs" → "Complete Packs"); anything new (e.g. "Stud Testing (2.3)") is created
            and you can set its time on the Process Times page.
          </p>
          <p className="text-gray-500">Re-running re-assigns; a SKU not in the catalog is reported as unknown.</p>
        </div>
      </div>

      <div className="card mb-6">
        <div className="card-body">
          <Form method="post" encType="multipart/form-data">
            <div className="form-group">
              <label htmlFor="csvFile" className="form-label">CSV file</label>
              <input id="csvFile" type="file" name="csvFile" accept=".csv,text/csv" className="form-input" required />
            </div>
            <div className="flex gap-3">
              <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
                {isSubmitting ? "Importing…" : "Import Assignments"}
              </button>
              <Link to="/capacity" className="btn btn-secondary">Back to Process Times</Link>
            </div>
          </Form>
        </div>
      </div>

      {result && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="card">
            <div className="card-header"><h3 className="card-title">By process</h3></div>
            <div className="card-body text-sm">
              <ul className="space-y-1">{summary.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </div>
          </div>
          <div className="card">
            <div className="card-header"><h3 className="card-title">New processes ({processesCreated.length})</h3></div>
            <div className="card-body text-sm">
              {processesCreated.length === 0 ? <p className="text-gray-500">None.</p> : (
                <ul className="space-y-1">{processesCreated.map((p, i) => <li key={i}>{p}</li>)}</ul>
              )}
            </div>
          </div>
          <div className="card">
            <div className="card-header"><h3 className="card-title">Unknown SKUs ({unknown.length})</h3></div>
            <div className="card-body text-sm">
              {unknown.length === 0 ? <p className="text-gray-500">None.</p> : (
                <ul className="space-y-1">{unknown.map((u, i) => <li key={i} className="text-red-600 font-mono text-xs">{u}</li>)}</ul>
              )}
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}
