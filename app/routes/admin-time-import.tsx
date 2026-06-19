import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation, Link } from "react-router";
import { requireRole, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import type { TimeEntryStatus } from "@prisma/client";

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
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}

// The time clock exports wall-clock times in the shop's timezone (Mountain).
// The server runs UTC, so convert the wall time -> the correct UTC instant
// (DST-aware via Intl) or stored times would display hours off.
const SHOP_TZ = "America/Denver";
const tzParts = new Intl.DateTimeFormat("en-US", {
  timeZone: SHOP_TZ,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

function zonedWallToUtc(y: number, mo: number, d: number, h: number, mi: number): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi); // components treated as UTC
  const p = tzParts.formatToParts(new Date(guess));
  const get = (t: string) => parseInt(p.find((x) => x.type === t)?.value || "0", 10);
  let hr = get("hour");
  if (hr === 24) hr = 0; // some ICU versions emit "24" for midnight
  const shopAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hr, get("minute"), get("second"));
  return new Date(guess + (guess - shopAsUtc)); // add the tz offset
}

// Parse "M/D/YY H:MM" (e.g. "6/17/26 7:01") as a Mountain wall-clock time.
function parseDateTime(s: string): Date | null {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  let y = parseInt(m[3], 10);
  if (y < 100) y += 2000;
  const date = zonedWallToUtc(y, parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[4], 10), parseInt(m[5], 10));
  return isNaN(date.getTime()) ? null : date;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const admin = await requireRole(request, ["ADMIN"]);
  const formData = await request.formData();

  const csvFile = formData.get("csvFile") as File | null;
  const statusInput = ((formData.get("status") as string) || "APPROVED").toUpperCase();
  const status: TimeEntryStatus = ["DRAFT", "PENDING", "APPROVED"].includes(statusInput)
    ? (statusInput as TimeEntryStatus)
    : "APPROVED";

  if (!csvFile || csvFile.size === 0) {
    return { error: "Please choose a CSV file." };
  }

  const text = (await csvFile.text()).replace(/^﻿/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) {
    return { error: "The CSV looks empty (no data rows)." };
  }

  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const nameIdx = header.findIndex((h) => h.includes("name"));
  const hoursIdx = header.findIndex((h) => h.includes("hours"));
  const inIdx = header.findIndex((h) => h.includes("punch in") || h.includes("clock in") || h.includes("time in"));
  const outIdx = header.findIndex((h) => h.includes("punch out") || h.includes("clock out") || h.includes("time out"));
  if (nameIdx === -1 || inIdx === -1 || outIdx === -1) {
    return { error: 'Need columns for Name, First Punch In, and Last Punch Out.' };
  }

  // Preload users for name matching ("Last, First").
  const users = await prisma.user.findMany({ select: { id: true, firstName: true, lastName: true } });
  const byName = new Map<string, { id: string }>();
  for (const u of users) {
    byName.set(`${u.lastName.trim().toLowerCase()}|${u.firstName.trim().toLowerCase()}`, { id: u.id });
  }

  const created: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const v = parseCsvLine(lines[i]);
    const fullName = (v[nameIdx] || "").trim();
    if (!fullName) continue;

    const comma = fullName.indexOf(",");
    const lastName = (comma >= 0 ? fullName.slice(0, comma) : fullName).trim();
    const firstName = (comma >= 0 ? fullName.slice(comma + 1) : "").trim();
    const match = byName.get(`${lastName.toLowerCase()}|${firstName.toLowerCase()}`);
    if (!match) {
      errors.push(`No user account matches "${fullName}" — create them first.`);
      continue;
    }

    const clockIn = parseDateTime(v[inIdx] || "");
    const clockOut = parseDateTime(v[outIdx] || "");
    if (!clockIn || !clockOut) {
      errors.push(`${fullName}: couldn't read punch times ("${v[inIdx]}" / "${v[outIdx]}").`);
      continue;
    }
    if (clockOut <= clockIn) {
      errors.push(`${fullName}: punch out is not after punch in.`);
      continue;
    }

    const spanMinutes = Math.round((clockOut.getTime() - clockIn.getTime()) / 60000);
    const totalHours = hoursIdx >= 0 ? parseFloat(v[hoursIdx] || "") : NaN;
    const actualMinutes = Number.isFinite(totalHours) ? Math.round(totalHours * 60) : spanMinutes;
    const breakMinutes = Math.max(0, spanMinutes - actualMinutes);

    const dateLabel = clockIn.toLocaleDateString("en-US", { timeZone: SHOP_TZ });

    // Skip if this worker already has an entry on this calendar day.
    const dayStart = new Date(clockIn);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(clockIn);
    dayEnd.setHours(23, 59, 59, 999);
    const existing = await prisma.workerTimeEntry.findFirst({
      where: { userId: match.id, clockInTime: { gte: dayStart, lte: dayEnd } },
    });
    if (existing) {
      skipped.push(`${fullName} — ${dateLabel} already has a time entry.`);
      continue;
    }

    try {
      await prisma.$transaction(async (tx) => {
        const clockInEvent = await tx.clockEvent.create({
          data: { userId: match.id, type: "CLOCK_IN", timestamp: clockIn, notes: "Imported from time-clock CSV" },
        });
        const clockOutEvent = await tx.clockEvent.create({
          data: { userId: match.id, type: "CLOCK_OUT", timestamp: clockOut, notes: "Imported from time-clock CSV" },
        });
        const entry = await tx.workerTimeEntry.create({
          data: {
            userId: match.id,
            clockInEventId: clockInEvent.id,
            clockOutEventId: clockOutEvent.id,
            clockInTime: clockIn,
            clockOutTime: clockOut,
            breakMinutes,
            actualMinutes,
            status,
            approvedById: status === "APPROVED" ? admin.id : null,
            approvedAt: status === "APPROVED" ? new Date() : null,
          },
        });
        await createAuditLog(admin.id, "IMPORT_TIME_ENTRY", "WorkerTimeEntry", entry.id, {
          source: "csv",
          name: fullName,
          date: dateLabel,
          actualMinutes,
          breakMinutes,
          status,
        });
      });
      created.push(`${fullName} — ${dateLabel} (${(actualMinutes / 60).toFixed(2)}h${breakMinutes ? `, ${breakMinutes}m break` : ""})`);
    } catch (e) {
      errors.push(`${fullName} — ${dateLabel}: ${e instanceof Error ? e.message : "error"}`);
    }
  }

  return { success: true, created, skipped, errors, status };
};

export default function AdminTimeImport() {
  const { user } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const result = actionData && "success" in actionData ? actionData : null;
  const created = result?.created ?? [];
  const skipped = result?.skipped ?? [];
  const errors = result?.errors ?? [];

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Import Time Entries from CSV</h1>
        <p className="page-subtitle">
          Bulk-load punch data from your time clock. Re-running is safe — a worker who already has an
          entry for a day is skipped.
        </p>
      </div>

      {actionData && "error" in actionData && actionData.error && (
        <div className="alert alert-error mb-6">{actionData.error}</div>
      )}

      {result && (
        <div className="alert alert-success mb-6">
          Imported {created.length} entr{created.length === 1 ? "y" : "ies"} as <strong>{result.status}</strong>
          {skipped.length > 0 ? `, skipped ${skipped.length} existing` : ""}
          {errors.length > 0 ? `, ${errors.length} error(s)` : ""}.
        </div>
      )}

      <div className="card mb-6">
        <div className="card-header"><h2 className="card-title">CSV format</h2></div>
        <div className="card-body text-sm text-gray-700 space-y-2">
          <p>
            A header row, then one row per worker per day. Columns matched by name:
            {" "}<strong>Name</strong> ("Last, First"), <strong>First Punch In</strong> and{" "}
            <strong>Last Punch Out</strong> ("M/D/YY H:MM"), and optional <strong>Total Hours</strong>.
          </p>
          <p className="text-gray-500">
            Workers are matched to existing accounts by name (import them on the Users page first).
            Worked minutes come from Total Hours; the difference between the punch span and Total
            Hours is recorded as break time. Times are stored as written.
          </p>
        </div>
      </div>

      <div className="card mb-6">
        <div className="card-body">
          <Form method="post" encType="multipart/form-data">
            <div className="form-group">
              <label htmlFor="csvFile" className="form-label">CSV file</label>
              <input id="csvFile" type="file" name="csvFile" accept=".csv,text/csv" className="form-input" required />
            </div>
            <div className="form-group">
              <label htmlFor="status" className="form-label">Import as</label>
              <select id="status" name="status" className="form-input" defaultValue="APPROVED">
                <option value="APPROVED">Approved — counts for payroll immediately</option>
                <option value="PENDING">Pending — shows in Time Entry Approvals for review</option>
                <option value="DRAFT">Draft — not counted until approved</option>
              </select>
            </div>
            <div className="flex gap-3">
              <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
                {isSubmitting ? "Importing…" : "Import Time Entries"}
              </button>
              <Link to="/time-entry-approvals" className="btn btn-secondary">Time Entry Approvals</Link>
            </div>
          </Form>
        </div>
      </div>

      {result && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="card">
            <div className="card-header"><h3 className="card-title">Imported ({created.length})</h3></div>
            <div className="card-body text-sm">
              {created.length === 0 ? <p className="text-gray-500">None.</p> : (
                <ul className="space-y-1">{created.map((c, i) => <li key={i} className="text-xs">{c}</li>)}</ul>
              )}
            </div>
          </div>
          <div className="card">
            <div className="card-header"><h3 className="card-title">Skipped ({skipped.length})</h3></div>
            <div className="card-body text-sm">
              {skipped.length === 0 ? <p className="text-gray-500">None.</p> : (
                <ul className="space-y-1">{skipped.map((s, i) => <li key={i} className="text-gray-600">{s}</li>)}</ul>
              )}
            </div>
          </div>
          <div className="card">
            <div className="card-header"><h3 className="card-title">Errors ({errors.length})</h3></div>
            <div className="card-body text-sm">
              {errors.length === 0 ? <p className="text-gray-500">None.</p> : (
                <ul className="space-y-1">{errors.map((e, i) => <li key={i} className="text-red-600">{e}</li>)}</ul>
              )}
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}
