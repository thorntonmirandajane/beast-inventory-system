import type { LoaderFunctionArgs } from "react-router";
import { requireRole } from "../utils/auth.server";
import prisma from "../db.server";

const ymd = (d: Date | null) => (d ? new Date(d).toISOString().split("T")[0] : "");
const csvCell = (v: string | number | null | undefined) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// GET /reports/approved-production?from=YYYY-MM-DD&to=YYYY-MM-DD -> CSV download.
// Approved production lines: worker, date, process, SKU, quantities.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireRole(request, ["ADMIN", "MANAGER"]);
  const url = new URL(request.url);

  const to = url.searchParams.get("to") ? new Date(`${url.searchParams.get("to")}T23:59:59`) : new Date();
  const from = url.searchParams.get("from")
    ? new Date(`${url.searchParams.get("from")}T00:00:00`)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const lines = await prisma.timeEntryLine.findMany({
    where: {
      isMisc: false,
      timeEntry: { status: "APPROVED", clockInTime: { gte: from, lte: to } },
    },
    select: {
      quantityCompleted: true,
      adminAdjustedQuantity: true,
      isRejected: true,
      rejectionQuantity: true,
      processName: true,
      sku: { select: { sku: true, name: true } },
      timeEntry: {
        select: {
          clockInTime: true,
          approvedAt: true,
          user: { select: { firstName: true, lastName: true } },
        },
      },
    },
    orderBy: [{ timeEntry: { clockInTime: "desc" } }],
  });

  const header = [
    "Date",
    "Worker",
    "Process",
    "SKU",
    "SKU Name",
    "Submitted Qty",
    "Adjusted Qty",
    "Rejected Qty",
    "Accepted Qty",
    "Approved At",
  ];
  const rows = lines.map((l) => {
    const base = l.adminAdjustedQuantity ?? l.quantityCompleted;
    const rejected = l.isRejected ? l.rejectionQuantity ?? base : 0;
    const accepted = Math.max(0, base - rejected);
    return [
      ymd(l.timeEntry.clockInTime),
      `${l.timeEntry.user.firstName} ${l.timeEntry.user.lastName}`,
      l.processName,
      l.sku?.sku ?? "",
      l.sku?.name ?? "",
      l.quantityCompleted,
      l.adminAdjustedQuantity ?? "",
      rejected,
      accepted,
      ymd(l.timeEntry.approvedAt),
    ];
  });

  const csv = [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
  const fname = `approved-production_${ymd(from)}_to_${ymd(to)}.csv`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fname}"`,
    },
  });
};
