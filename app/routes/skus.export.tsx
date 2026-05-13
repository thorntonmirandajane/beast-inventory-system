import type { LoaderFunctionArgs } from "react-router";
import { requireRole } from "../utils/auth.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN"]);

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

  // Map raw process names ("STUD_TESTING") to display names ("Stud Tested")
  // so the CSV matches what the inventory dashboard shows.
  const processConfigs = await prisma.processConfig.findMany({
    select: { processName: true, displayName: true },
  });
  const processDisplayMap = new Map(processConfigs.map((p) => [p.processName, p.displayName]));

  // Build CSV data
  const csvRows: string[] = [];

  // Headers
  csvRows.push([
    "SKU",
    "Name",
    "Type",
    "Category",
    "Process",
    "UPC",
    "Description",
    "Is Active",
    "Total Inventory",
    "RAW",
    "ASSEMBLED",
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

    // Mirror the inventory dashboard's display rules so the CSV doesn't
    // look like a different system:
    //   - RAW items always read "N/A" for category
    //   - Other types show the stored category with underscores replaced
    //   - Process uses ProcessConfig.displayName when available
    const categoryDisplay =
      sku.type === "RAW"
        ? "N/A"
        : sku.category
        ? sku.category.replaceAll("_", " ")
        : "";
    const processDisplay = sku.material
      ? processDisplayMap.get(sku.material) ?? sku.material
      : "";

    csvRows.push([
      escapeCsv(sku.sku),
      escapeCsv(sku.name),
      sku.type,
      escapeCsv(categoryDisplay),
      escapeCsv(processDisplay),
      sku.upc || "",
      escapeCsv(sku.description || ""),
      sku.isActive ? "Yes" : "No",
      totalInventory.toString(),
      (inventoryByState.RAW || 0).toString(),
      (inventoryByState.ASSEMBLED || 0).toString(),
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
