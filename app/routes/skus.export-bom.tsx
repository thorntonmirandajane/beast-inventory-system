import type { LoaderFunctionArgs } from "react-router";
import { requireRole } from "../utils/auth.server";
import prisma from "../db.server";

// Recursive BOM-tree export. For every top-level SKU (Assembly + Completed)
// that has components, walks its BOM tree and emits one indented row per
// node so the file can be scanned to audit that BOMs roll up correctly.
//
// Layout: one block per top-level SKU, separated by a blank row. Inside a
// block, depth-0 is the root, depth-1 are direct components, etc.
// "Qty per parent" is what's stored on the BomComponent edge. "Qty per
// root" is the multiplied total — handy for "this completed pack needs X
// of this raw material per unit shipped" checks.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN"]);
  if (user.role !== "ADMIN") {
    throw new Response("Unauthorized", { status: 403 });
  }

  // Pull every active SKU into an in-memory map up front so the recursion
  // doesn't generate N+1 queries.
  const allSkus = await prisma.sku.findMany({
    where: { isActive: true },
    include: {
      inventoryItems: true,
      bomComponents: {
        include: {
          componentSku: { select: { id: true } },
        },
      },
    },
    orderBy: [{ type: "asc" }, { sku: "asc" }],
  });
  const skuById = new Map(allSkus.map((s) => [s.id, s]));

  const onHand = (skuId: string): number => {
    const s = skuById.get(skuId);
    if (!s) return 0;
    return s.inventoryItems.reduce((sum, i) => sum + i.quantity, 0);
  };

  type Row = {
    rootSku: string;
    rootName: string;
    depth: number;
    tree: string;
    sku: string;
    name: string;
    type: string;
    qtyPerParent: number | "";
    qtyPerRoot: number | "";
    onHand: number;
  };

  const rows: Row[] = [];

  function walk(
    rootSku: string,
    rootName: string,
    currentSkuId: string,
    qtyPerParent: number,
    qtyPerRoot: number,
    depth: number,
    visited: Set<string>
  ) {
    const sku = skuById.get(currentSkuId);
    if (!sku) return;

    if (visited.has(currentSkuId)) {
      rows.push({
        rootSku,
        rootName,
        depth,
        tree: `${"  ".repeat(depth)}- ${sku.sku} (CYCLE - skipping)`,
        sku: sku.sku,
        name: sku.name,
        type: sku.type,
        qtyPerParent,
        qtyPerRoot,
        onHand: onHand(currentSkuId),
      });
      return;
    }
    const next = new Set(visited);
    next.add(currentSkuId);

    rows.push({
      rootSku,
      rootName,
      depth,
      // Plain ASCII tree — survives Excel encoding quirks and any tool
      // that doesn't honour a UTF-8 BOM. Two leading spaces per depth
      // plus a trailing "- " marker.
      tree: depth === 0 ? sku.sku : `${"  ".repeat(depth)}- ${sku.sku}`,
      sku: sku.sku,
      name: sku.name,
      type: sku.type,
      qtyPerParent: depth === 0 ? "" : qtyPerParent,
      qtyPerRoot: depth === 0 ? "" : qtyPerRoot,
      onHand: onHand(currentSkuId),
    });

    for (const bom of sku.bomComponents) {
      walk(
        rootSku,
        rootName,
        bom.componentSku.id,
        bom.quantity,
        qtyPerRoot * bom.quantity,
        depth + 1,
        next
      );
    }
  }

  const topLevelSkus = allSkus.filter(
    (s) => (s.type === "ASSEMBLY" || s.type === "COMPLETED") && s.bomComponents.length > 0
  );

  for (const root of topLevelSkus) {
    walk(root.sku, root.name, root.id, 1, 1, 0, new Set());
    rows.push({
      rootSku: "",
      rootName: "",
      depth: 0,
      tree: "",
      sku: "",
      name: "",
      type: "",
      qtyPerParent: "",
      qtyPerRoot: "",
      onHand: 0,
    });
  }

  // ---- CSV ----
  const csvRows: string[] = [];
  csvRows.push(
    [
      "Root SKU",
      "Root Name",
      "Depth",
      "Tree",
      "SKU",
      "Name",
      "Type",
      "Qty per parent",
      "Qty per root",
      "On hand",
    ].join(",")
  );

  for (const r of rows) {
    if (r.sku === "" && r.rootSku === "") {
      csvRows.push("");
      continue;
    }
    csvRows.push(
      [
        escapeCsv(r.rootSku),
        escapeCsv(r.rootName),
        String(r.depth),
        escapeCsv(r.tree),
        escapeCsv(r.sku),
        escapeCsv(r.name),
        r.type,
        r.qtyPerParent === "" ? "" : String(r.qtyPerParent),
        r.qtyPerRoot === "" ? "" : String(r.qtyPerRoot),
        String(r.onHand),
      ].join(",")
    );
  }

  // ﻿ = UTF-8 byte-order mark — tells Excel to treat this as UTF-8
  // so any unicode characters (en-dashes in names, etc.) render correctly.
  const csv = "﻿" + csvRows.join("\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="bom-tree-export-${new Date().toISOString().split("T")[0]}.csv"`,
    },
  });
};

function escapeCsv(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
