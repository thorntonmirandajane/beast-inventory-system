import type { ActionFunctionArgs } from "react-router";
import { requireUser } from "../utils/auth.server";
import prisma from "../db.server";

// SKU renames
const skuRenames = [
  { oldSku: "D6-3PACK-23IN-100G", newSku: "D6-3PACK-100g-2.3in" },
  { oldSku: "D6-3PACK-23IN-125G", newSku: "D6-3PACK-100g-2.0in" },
  { oldSku: "D6-3PACK-2IN-100G", newSku: "D6-3PACK-125g-2.3in" },
  { oldSku: "D6-3PACK-2IN-125G", newSku: "D6-3PACK-125g-2.0in" },
  { oldSku: "PT-100G-BEAST", newSku: "3PACK-PT-100G" },
  { oldSku: "PT-125G-BEAST", newSku: "3PACK-PT-125G" },
  { oldSku: "ST-3PACK-2IN-150G", newSku: "3PACK-150g-2.0in" },
  { oldSku: "TR-3PACK-23IN-100G", newSku: "TRUMP-3PACK-100g-2.3in" },
  { oldSku: "TR-3PACK-23IN-125G", newSku: "TRUMP-3PACK-23IN-125G" },
  { oldSku: "TR-3PACK-2IN-100G", newSku: "TRUMP-3PACK-125g-2.3in" },
  { oldSku: "TR-3PACK-2IN-125G", newSku: "TRUMP-3PACK-125g-2.0in" },
];

// Process order assignments from the CSV (row number -> SKU)
const processOrders: { sku: string; order: number }[] = [
  { sku: "TI-100-TIPPED-FERRULE", order: 1 },
  { sku: "TI-2IN-100G-BLADED-FERRULE", order: 2 },
  { sku: "TI-2IN-100G-BEAST", order: 3 },
  { sku: "TI-3PACK-100g-2.0in", order: 4 },
  { sku: "TI-23IN-100G-BLADED-FERRULE", order: 5 },
  { sku: "TI-23IN-100G-BEAST", order: 6 },
  { sku: "TI-3PACK-100g-2.3in", order: 7 },
  { sku: "TI-TIPPED-FERRULE", order: 8 },
  { sku: "TI-2IN-BLADED-FERRULE", order: 9 },
  { sku: "TI-2IN-125G-BEAST", order: 10 },
  { sku: "TI-2PACK-125g-2.0in", order: 11 },
  { sku: "TI-3PACK-125g-2.0in", order: 12 },
  { sku: "TI-23IN-BLADED-FERRULE", order: 13 },
  { sku: "TI-23IN-125G-BEAST", order: 14 },
  { sku: "TI-3PACK-125g-2.3in", order: 15 },
  { sku: "TIPPED-FERRULE", order: 16 },
  { sku: "23IN-BLADED-FERRULE", order: 17 },
  { sku: "23IN-100G-BEAST", order: 18 },
  { sku: "2PACK-100g-2.3in", order: 19 },
  { sku: "3PACK-100g-2.3in", order: 20 },
  { sku: "23IN-125G-BEAST", order: 21 },
  { sku: "2PACK-125g-2.3in", order: 22 },
  { sku: "3PACK-125g-2.3in", order: 23 },
  { sku: "D6-23IN-100G-BEAST", order: 24 },
  { sku: "D6-3PACK-100g-2.3in", order: 25 },
  { sku: "D6-23IN-125G-BEAST", order: 26 },
  { sku: "D6-3PACK-125g-2.3in", order: 27 },
  { sku: "2IN-BLADED-FERRULE", order: 28 },
  { sku: "2IN-100G-BEAST", order: 29 },
  { sku: "2PACK-100g-2.0in", order: 30 },
  { sku: "3PACK-100g-2.0in", order: 31 },
  { sku: "2IN-125G-BEAST", order: 32 },
  { sku: "2PACK-125g-2.0in", order: 33 },
  { sku: "3PACK-125g-2.0in", order: 34 },
  { sku: "D6-2IN-100G-BEAST", order: 35 },
  { sku: "D6-3PACK-100g-2.0in", order: 36 },
  { sku: "D6-2IN-125G-BEAST", order: 37 },
  { sku: "D6-3PACK-125g-2.0in", order: 38 },
  { sku: "ST-TIPPED-FERRULE", order: 39 },
  { sku: "ST-2IN-BLADED-FERRULE", order: 40 },
  { sku: "ST-2IN-150G-BEAST", order: 41 },
  { sku: "3PACK-150g-2.0in", order: 42 },
  { sku: "TR-TIPPED-FERRULE", order: 43 },
  { sku: "TR-2IN-BLADED-FERRULE", order: 44 },
  { sku: "TR-2IN-100G-BEAST", order: 45 },
  { sku: "TRUMP-3PACK-100g-2.0in", order: 46 },
  { sku: "TR-2IN-125G-BEAST", order: 47 },
  { sku: "TRUMP-3PACK-125g-2.0in", order: 48 },
  { sku: "TR-23IN-BLADED-FERRULE", order: 49 },
  { sku: "TR-23IN-100G-BEAST", order: 50 },
  { sku: "TRUMP-3PACK-100g-2.3in", order: 51 },
  { sku: "TR-23IN-125G-BEAST", order: 52 },
  { sku: "TRUMP-3PACK-23IN-125G", order: 53 },
  { sku: "3PACK-PT-100G", order: 54 },
  { sku: "3PACK-PT-125G", order: 55 },
];

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);

  if (user.role !== "ADMIN") {
    return Response.json({ error: "Unauthorized" }, { status: 403 });
  }

  const results = {
    renamed: [] as string[],
    alreadyRenamed: [] as string[],
    notFound: [] as string[],
    orderUpdated: [] as string[],
    orderNotFound: [] as string[],
  };

  // Step 1: Rename SKUs
  for (const { oldSku, newSku } of skuRenames) {
    const existing = await prisma.sku.findUnique({ where: { sku: oldSku } });

    if (!existing) {
      // Check if new SKU already exists
      const newExists = await prisma.sku.findUnique({ where: { sku: newSku } });
      if (newExists) {
        results.alreadyRenamed.push(`${oldSku} -> ${newSku}`);
      } else {
        results.notFound.push(oldSku);
      }
      continue;
    }

    // Check for conflict
    const conflict = await prisma.sku.findUnique({ where: { sku: newSku } });
    if (conflict) {
      results.alreadyRenamed.push(`${oldSku} -> ${newSku} (conflict)`);
      continue;
    }

    await prisma.sku.update({
      where: { sku: oldSku },
      data: { sku: newSku },
    });
    results.renamed.push(`${oldSku} -> ${newSku}`);
  }

  // Step 2: Update process orders
  for (const { sku, order } of processOrders) {
    const existing = await prisma.sku.findUnique({ where: { sku } });

    if (!existing) {
      results.orderNotFound.push(sku);
      continue;
    }

    await prisma.sku.update({
      where: { sku },
      data: { processOrder: order },
    });
    results.orderUpdated.push(`${sku} = ${order}`);
  }

  return Response.json({
    success: true,
    message: "SKU fix completed",
    results,
  });
};

export const loader = async ({ request }: { request: Request }) => {
  const user = await requireUser(request);

  if (user.role !== "ADMIN") {
    return Response.json({ error: "Unauthorized" }, { status: 403 });
  }

  return Response.json({
    message: "POST to this endpoint to run SKU renames and order updates",
    skuRenames: skuRenames.length,
    orderUpdates: processOrders.length,
  });
};
