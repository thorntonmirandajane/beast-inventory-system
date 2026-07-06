import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation, Link } from "react-router";
import { requireRole, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";

const pad = (n: number) => String(n).padStart(2, "0");

function parseTime12(s: string): string | null {
  const m = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(s.trim());
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = m[3].toUpperCase();
  if (ap === "PM" && h !== 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return `${pad(h)}:${pad(min)}`;
}
function parseMDY(s: string): { y: number; mo: number; d: number } | null {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s.trim());
  if (!m) return null;
  return { mo: +m[1], d: +m[2], y: +m[3] };
}
function isSubsequence(sub: string, str: string): boolean {
  let i = 0;
  for (const c of str) if (i < sub.length && c === sub[i]) i++;
  return i === sub.length;
}

type Usr = { id: string; firstName: string; lastName: string };
// Match "Andrew" or "Easton Hou"/"Easton Hdm" to a user: exact first name, then
// disambiguate duplicate first names by a last-name subsequence of the suffix.
function matchUser(csvName: string, users: Usr[]): Usr | null {
  const tokens = csvName.trim().split(/\s+/);
  const first = tokens[0].toLowerCase();
  const suffix = tokens.slice(1).join("").toLowerCase();
  const byFirst = users.filter((u) => u.firstName.toLowerCase() === first);
  if (byFirst.length === 1) return byFirst[0];
  if (byFirst.length === 0) return null;
  if (suffix) {
    const cand = byFirst.filter((u) => isSubsequence(suffix, u.lastName.toLowerCase()));
    if (cand.length === 1) return cand[0];
  }
  return null;
}

type Row = { employee: string; userId: string; userName: string; y: number; mo: number; d: number; dateKey: string; start: string; end: string };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN"]);
  return { user };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN"]);
  const formData = await request.formData();
  const apply = String(formData.get("intent") || "preview") === "apply";

  const file = formData.get("csvFile") as File | null;
  let text = String(formData.get("csv") || "");
  if (file && file.size > 0) text = await file.text();
  text = text.replace(/^﻿/, ""); // strip BOM
  if (!text.trim()) return { error: "Upload a CSV or paste rows first." };

  const users = await prisma.user.findMany({
    where: { isActive: true },
    select: { id: true, firstName: true, lastName: true },
  });

  const rows: Row[] = [];
  const errors: string[] = [];
  const unmatched = new Map<string, number>();

  text.split(/\r?\n/).forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) return;
    const cells = line.split(",").map((c) => c.trim());
    if (idx === 0 && /employee/i.test(cells[0] || "")) return; // header
    const [employee, dateStr, inStr, outStr] = cells;
    if (!employee || !dateStr || !inStr || !outStr) {
      errors.push(`Line ${idx + 1}: missing fields — "${line}"`);
      return;
    }
    const date = parseMDY(dateStr);
    const start = parseTime12(inStr);
    const end = parseTime12(outStr);
    if (!date || !start || !end) {
      errors.push(`Line ${idx + 1}: couldn't read date/time — "${line}"`);
      return;
    }
    const matched = matchUser(employee, users);
    if (!matched) {
      unmatched.set(employee, (unmatched.get(employee) ?? 0) + 1);
      return;
    }
    rows.push({
      employee,
      userId: matched.id,
      userName: `${matched.firstName} ${matched.lastName}`,
      y: date.y,
      mo: date.mo,
      d: date.d,
      dateKey: `${date.y}-${pad(date.mo)}-${pad(date.d)}`,
      start,
      end,
    });
  });

  if (rows.length === 0 && unmatched.size === 0) {
    return { error: "No schedule rows found.", parseErrors: errors };
  }

  const unmatchedList = Array.from(unmatched.entries()).map(([name, count]) => ({ name, count }));
  const dateKeys = new Set(rows.map((r) => r.dateKey));

  if (apply) {
    // Idempotent: clear existing specific-date shifts for each (user, date) in the
    // file, then insert all rows (supports split shifts as separate rows).
    const pairs = new Map<string, { userId: string; y: number; mo: number; d: number }>();
    for (const r of rows) pairs.set(`${r.userId}|${r.dateKey}`, { userId: r.userId, y: r.y, mo: r.mo, d: r.d });
    for (const p of pairs.values()) {
      const dayStart = new Date(p.y, p.mo - 1, p.d, 0, 0, 0, 0);
      const dayEnd = new Date(p.y, p.mo - 1, p.d, 23, 59, 59, 999);
      await prisma.workerSchedule.deleteMany({
        where: { userId: p.userId, scheduleType: "SPECIFIC_DATE", scheduleDate: { gte: dayStart, lte: dayEnd } },
      });
    }
    await prisma.workerSchedule.createMany({
      data: rows.map((r) => ({
        userId: r.userId,
        scheduleType: "SPECIFIC_DATE" as const,
        scheduleDate: new Date(r.y, r.mo - 1, r.d, 12, 0, 0, 0),
        dayOfWeek: null,
        startTime: r.start,
        endTime: r.end,
        isActive: true,
      })),
    });
    await createAuditLog(user.id, "IMPORT_SCHEDULES", "WorkerSchedule", "bulk", {
      shifts: rows.length,
      dates: dateKeys.size,
      unmatched: unmatchedList.length,
    });
  }

  return { rows, unmatchedList, parseErrors: errors, dates: dateKeys.size, applied: apply };
};

export default function SchedulesImport() {
  const { user } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const rows = actionData && "rows" in actionData ? actionData.rows : null;
  const unmatched = (actionData && "unmatchedList" in actionData ? actionData.unmatchedList : []) ?? [];
  const applied = !!(actionData && "applied" in actionData && actionData.applied);

  return (
    <Layout user={user}>
      <div className="page-header flex items-start justify-between">
        <div>
          <h1 className="page-title">Import Schedules (CSV)</h1>
          <p className="page-subtitle">Columns: <strong>Employee, Date, Time In, Time Out</strong>. Matches by first name; two shifts on one day are kept as a split shift.</p>
        </div>
        <Link to="/schedules" className="btn btn-ghost">← Schedules</Link>
      </div>

      {actionData && "error" in actionData && actionData.error && <div className="alert alert-error mb-4">{actionData.error}</div>}
      {applied && rows && (
        <div className="alert alert-success mb-4">Imported {rows.length} shift(s) across {"dates" in actionData! ? actionData!.dates : 0} date(s){unmatched.length ? `, ${unmatched.length} name(s) skipped` : ""}.</div>
      )}

      <div className="card mb-6">
        <div className="card-body">
          <Form method="post" encType="multipart/form-data" className="space-y-4">
            <div className="form-group">
              <label htmlFor="csvFile" className="form-label">CSV file</label>
              <input id="csvFile" type="file" name="csvFile" accept=".csv,text/csv" className="form-input" />
            </div>
            <div className="form-group">
              <label htmlFor="csv" className="form-label">…or paste rows</label>
              <textarea id="csv" name="csv" rows={5} className="form-input font-mono text-sm" placeholder={"Andrew,7/6/2026,7:00 AM,3:00 PM"} />
            </div>
            <div className="flex gap-3">
              <button type="submit" name="intent" value="preview" className="btn btn-secondary" disabled={busy}>{busy ? "Working…" : "Preview"}</button>
              <button
                type="submit"
                name="intent"
                value="apply"
                className="btn btn-primary"
                disabled={busy}
                onClick={(e) => { if (!confirm("Import these schedules? Existing shifts on the same dates for these workers will be replaced.")) e.preventDefault(); }}
              >
                {busy ? "Working…" : "Import Schedules"}
              </button>
            </div>
          </Form>
        </div>
      </div>

      {actionData && "parseErrors" in actionData && actionData.parseErrors && actionData.parseErrors.length > 0 && (
        <div className="alert alert-warning whitespace-pre-line mb-4">{actionData.parseErrors.join("\n")}</div>
      )}

      {unmatched.length > 0 && (
        <div className="alert alert-error mb-4">
          <strong>{unmatched.length} name(s) didn't match a worker</strong> (skipped — create the user or fix the name):{" "}
          {unmatched.map((u) => `${u.name} (${u.count})`).join(", ")}
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">{applied ? "Imported" : "Preview"} — {rows.length} shift(s)</h2>
          </div>
          <div className="card-body overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr><th>CSV name</th><th>Worker</th><th>Date</th><th className="text-right">In</th><th className="text-right">Out</th></tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="text-sm">{r.employee}</td>
                    <td className="text-sm font-medium">{r.userName}</td>
                    <td className="text-sm">{r.dateKey}</td>
                    <td className="text-right text-sm">{r.start}</td>
                    <td className="text-right text-sm">{r.end}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Layout>
  );
}
