import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation, Link } from "react-router";
import { requireRole, createAuditLog, hashPassword } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import type { UserRole } from "@prisma/client";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN"]);
  return { user };
};

// Parse one CSV line, honoring quoted fields (so "Barnum, Townes" stays one cell).
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

function mapRole(roleStr: string): UserRole {
  const r = roleStr.toLowerCase();
  if (r.includes("admin")) return "ADMIN";
  if (r.includes("manager")) return "MANAGER";
  return "WORKER";
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN"]);
  const formData = await request.formData();

  const csvFile = formData.get("csvFile") as File | null;
  const defaultPassword = ((formData.get("defaultPassword") as string) || "").trim() || "Beast123!";

  if (!csvFile || csvFile.size === 0) {
    return { error: "Please choose a CSV file." };
  }
  if (defaultPassword.length < 6) {
    return { error: "Default password must be at least 6 characters." };
  }

  const text = (await csvFile.text()).replace(/^﻿/, ""); // strip BOM
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) {
    return { error: "The CSV looks empty (no data rows)." };
  }

  // Locate columns by header name (order-independent).
  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const nameIdx = header.findIndex((h) => h.includes("name"));
  const roleIdx = header.findIndex((h) => h.includes("role"));
  const emailIdx = header.findIndex((h) => h.includes("email"));
  if (nameIdx === -1) {
    return { error: 'Could not find a "Name" column in the header row.' };
  }

  const created: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const v = parseCsvLine(lines[i]);
    const fullName = (v[nameIdx] || "").trim();
    if (!fullName) continue;

    // Names are "Last, First". Fall back to "First Last" if there's no comma.
    let firstName: string;
    let lastName: string;
    const comma = fullName.indexOf(",");
    if (comma >= 0) {
      lastName = fullName.slice(0, comma).trim();
      firstName = fullName.slice(comma + 1).trim();
    } else {
      const parts = fullName.split(/\s+/);
      firstName = parts[0] || fullName;
      lastName = parts.slice(1).join(" ") || parts[0] || fullName;
    }

    const role = mapRole(roleIdx >= 0 ? v[roleIdx] || "" : "");
    let login = (emailIdx >= 0 ? v[emailIdx] || "" : "").trim().toLowerCase();

    try {
      if (login) {
        const exists = await prisma.user.findUnique({ where: { email: login } });
        if (exists) {
          skipped.push(`${firstName} ${lastName} — ${login} already exists`);
          continue;
        }
      } else {
        // No email: auto-generate a unique login from the name.
        const base = `${firstName}.${lastName}`.toLowerCase().replace(/[^a-z0-9.]/g, "") || "worker";
        login = base;
        let n = 1;
        while (await prisma.user.findUnique({ where: { email: login } })) {
          n += 1;
          login = `${base}${n}`;
        }
      }

      const hashed = await hashPassword(defaultPassword);
      const newUser = await prisma.user.create({
        data: { email: login, password: hashed, firstName, lastName, role },
      });
      await createAuditLog(user.id, "CREATE_USER", "User", newUser.id, {
        source: "csv-import",
        login,
        role,
      });
      created.push(`${firstName} ${lastName} — ${login} (${role})`);
    } catch (e) {
      errors.push(`${fullName}: ${e instanceof Error ? e.message : "error"}`);
    }
  }

  return { success: true, created, skipped, errors, defaultPassword };
};

export default function UsersImport() {
  const { user } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const result = actionData && "success" in actionData ? actionData : null;
  const created = result?.created ?? [];
  const skipped = result?.skipped ?? [];
  const errors = result?.errors ?? [];
  const defaultPassword = result?.defaultPassword ?? "Beast123!";

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Import Users from CSV</h1>
        <p className="page-subtitle">
          Bulk-create accounts. Existing emails are skipped, so it's safe to re-run.
        </p>
      </div>

      {actionData && "error" in actionData && actionData.error && (
        <div className="alert alert-error mb-6">{actionData.error}</div>
      )}

      {result && (
        <div className="alert alert-success mb-6">
          Created {created.length} user{created.length === 1 ? "" : "s"}
          {skipped.length > 0 ? `, skipped ${skipped.length} existing` : ""}
          {errors.length > 0 ? `, ${errors.length} error(s)` : ""}. Everyone signs in
          with their email (or generated login) and the password{" "}
          <strong>{defaultPassword}</strong>.
        </div>
      )}

      <div className="card mb-6">
        <div className="card-header">
          <h2 className="card-title">CSV format</h2>
        </div>
        <div className="card-body text-sm text-gray-700 space-y-2">
          <p>
            A header row, then one row per person. Columns are matched by name (order doesn't
            matter): a <strong>Name</strong> column ("Last, First"), a <strong>Role</strong> column
            (anything containing "admin" → ADMIN, "manager" → MANAGER, otherwise WORKER), and an
            optional <strong>Email</strong> column (blank → an auto-generated login like{" "}
            <code>first.last</code>).
          </p>
          <p className="text-gray-500">
            Phone numbers aren't stored (there's no phone field yet). The default password applies to
            everyone created; they can change it later.
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
              <label htmlFor="defaultPassword" className="form-label">Default password (everyone)</label>
              <input
                id="defaultPassword"
                type="text"
                name="defaultPassword"
                className="form-input"
                defaultValue="Beast123!"
                minLength={6}
              />
            </div>
            <div className="flex gap-3">
              <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
                {isSubmitting ? "Importing…" : "Import Users"}
              </button>
              <Link to="/users" className="btn btn-secondary">Back to Users</Link>
            </div>
          </Form>
        </div>
      </div>

      {result && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="card">
            <div className="card-header"><h3 className="card-title">Created ({created.length})</h3></div>
            <div className="card-body text-sm">
              {created.length === 0 ? (
                <p className="text-gray-500">None.</p>
              ) : (
                <ul className="space-y-1">{created.map((c, i) => <li key={i} className="font-mono text-xs">{c}</li>)}</ul>
              )}
            </div>
          </div>
          <div className="card">
            <div className="card-header"><h3 className="card-title">Skipped ({skipped.length})</h3></div>
            <div className="card-body text-sm">
              {skipped.length === 0 ? (
                <p className="text-gray-500">None.</p>
              ) : (
                <ul className="space-y-1">{skipped.map((s, i) => <li key={i} className="text-gray-600">{s}</li>)}</ul>
              )}
            </div>
          </div>
          <div className="card">
            <div className="card-header"><h3 className="card-title">Errors ({errors.length})</h3></div>
            <div className="card-body text-sm">
              {errors.length === 0 ? (
                <p className="text-gray-500">None.</p>
              ) : (
                <ul className="space-y-1">{errors.map((e, i) => <li key={i} className="text-red-600">{e}</li>)}</ul>
              )}
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}
