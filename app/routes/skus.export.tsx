import type { LoaderFunctionArgs } from "react-router";
import { requireUser } from "../utils/auth.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  // Only admins can export
  if (user.role !== "ADMIN") {
    throw new Response("Unauthorized", { status: 403 });
  }

  // Get all SKUs with inventory and BOM data
  const skus = await prisma.sku.findMany({
    include: {
      inventoryItems: true,
      bomComponents: {
        include: {
          componentSku: true,
        },
      },
      manufacturers: {
        include: {
          manufacturer: true,
        },
      },
    },
    orderBy: [{ type: "asc" }, { sku: "asc" }],
  });

  // Build CSV data
  const csvRows: string[] = [];

  // Headers
  csvRows.push([
    "SKU",
    "Name",
    "Type",
    "Category",
    "Material",
    "Description",
    "Is Active",
    "Total Inventory",
    "RAW",
    "RECEIVED",
    "ASSEMBLED",
    "COMPLETED",
    "TRANSFERRED",
    "BOM Components",
    "Manufacturers",
  ].join(","));

  // Data rows
  for (const sku of skus) {
    const inventoryByState = sku.inventoryItems.reduce(
      (acc, item) => {
        acc[item.state] = (acc[item.state] || 0) + item.quantity;
        return acc;
      },
      {} as Record<string, number>
    );

    const totalInventory = Object.values(inventoryByState).reduce((sum, qty) => sum + qty, 0);

    const bomComponents = sku.bomComponents
      .map((b) => `${b.componentSku.sku}:${b.quantity}`)
      .join(";");

    const manufacturers = sku.manufacturers
      .map((m) => {
        const parts = [m.manufacturer.name];
        if (m.cost) parts.push(`$${m.cost}`);
        if (m.leadTimeDays) parts.push(`${m.leadTimeDays}d`);
        if (m.isPreferred) parts.push("PREFERRED");
        return parts.join("|");
      })
      .join(";");

    csvRows.push([
      escapeCsv(sku.sku),
      escapeCsv(sku.name),
      sku.type,
      sku.category || "",
      sku.material || "",
      escapeCsv(sku.description || ""),
      sku.isActive ? "Yes" : "No",
      totalInventory.toString(),
      (inventoryByState.RAW || 0).toString(),
      (inventoryByState.RECEIVED || 0).toString(),
      (inventoryByState.ASSEMBLED || 0).toString(),
      (inventoryByState.COMPLETED || 0).toString(),
      (inventoryByState.TRANSFERRED || 0).toString(),
      escapeCsv(bomComponents),
      escapeCsv(manufacturers),
    ].join(","));
  }

  const csv = csvRows.join("\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="skus-export-${new Date().toISOString().split("T")[0]}.csv"`,
    },
  });
};

function escapeCsv(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
