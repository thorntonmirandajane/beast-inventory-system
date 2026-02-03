import type { ActionFunctionArgs } from "react-router";
import { requireUser } from "../utils/auth.server";
import prisma from "../db.server";

// SKU renames for COC and CB products
const skuRenames = [
  { oldSku: "3PACK-COC-100g-2.0", newSku: "COC-3PACK-100g-2.0in" },
  { oldSku: "3PACK-COC-100g-2.3", newSku: "COC-3PACK-100g-2.3in" },
  { oldSku: "3PACK-COC-125g-2.0", newSku: "COC-3PACK-125g-2.0in" },
  { oldSku: "3PACK-COC-125g-2.3", newSku: "COC-3PACK-125g-2.3in" },
  { oldSku: "TI-3PACK-COC-100g-2.0", newSku: "COC-TI-3PACK-100g-2.0in" },
  { oldSku: "TI-3PACK-COC-100g-2.3", newSku: "COC-TI-3PACK-100g-2.3in" },
  { oldSku: "TI-3PACK-COC-125g-2.0", newSku: "COC-TI-3PACK-125g-2.0in" },
  { oldSku: "TI-3PACK-COC-125g-2.3", newSku: "COC-TI-3PACK-125g-2.3in" },
  { oldSku: "3PACK-100g-2.0in-CB", newSku: "CB-3PACK-100g-2.0in" },
  { oldSku: "3PACK-100g-2.3in-CB", newSku: "CB-3PACK-100g-2.3in" },
  { oldSku: "3PACK-125g-2.0in-CB", newSku: "CB-3PACK-125g-2.0in" },
  { oldSku: "3PACK-125g-2.3in-CB", newSku: "CB-3PACK-125g-2.3in" },
  { oldSku: "TI-3PACK-125g-2.0in-CB", newSku: "CB-TI-3PACK-125g-2.0in" },
  { oldSku: "TI-3PACK-125g-2.3in-CB", newSku: "CB-TI-3PACK-125g-2.3in" },
  { oldSku: "TI-3PACK-100g-2.0in-CB", newSku: "CB-TI-3PACK-100g-2.0in" },
  { oldSku: "TI-3PACK-100g-2.3in-CB", newSku: "CB-TI-3PACK-100g-2.3in" },
  { oldSku: "3PACK-150g-2.0in-CB", newSku: "CB-3PACK-150g-2.0in" },
  { oldSku: "3PACK-COC-100g-2.0-CB", newSku: "CB-COC-3PACK-100g-2.0in" },
  { oldSku: "3PACK-COC-100g-2.3-CB", newSku: "CB-COC-3PACK-100g-2.3in" },
  { oldSku: "3PACK-COC-125g-2.0-CB", newSku: "CB-COC-3PACK-125g-2.0in" },
  { oldSku: "3PACK-COC-125g-2.3-CB", newSku: "CB-COC-3PACK-125g-2.3in" },
  { oldSku: "TI-3PACK-COC-125g-2.0-CB", newSku: "CB-COC-TI-3PACK-125g-2.0in" },
  { oldSku: "TI-3PACK-COC-125g-2.3-CB", newSku: "CB-COC-TI-3PACK-125g-2.3in" },
  { oldSku: "TI-3PACK-COC-100g-2.0-CB", newSku: "CB-COC-TI-3PACK-100g-2.0in" },
  { oldSku: "TI-3PACK-COC-100g-2.3-CB", newSku: "CB-COC-TI-3PACK-100g-2.3in" },
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
  };

  for (const { oldSku, newSku } of skuRenames) {
    const existing = await prisma.sku.findUnique({ where: { sku: oldSku } });

    if (!existing) {
      // Check if new SKU already exists (already renamed)
      const newExists = await prisma.sku.findUnique({ where: { sku: newSku } });
      if (newExists) {
        results.alreadyRenamed.push(`${oldSku} -> ${newSku}`);
      } else {
        results.notFound.push(oldSku);
      }
      continue;
    }

    // Check for conflict with new name
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

  return Response.json({
    success: true,
    message: "SKU rename completed",
    results,
  });
};

export const loader = async ({ request }: { request: Request }) => {
  const user = await requireUser(request);

  if (user.role !== "ADMIN") {
    return Response.json({ error: "Unauthorized" }, { status: 403 });
  }

  return Response.json({
    message: "POST to this endpoint to rename COC and CB SKUs",
    skuRenames: skuRenames.length,
    renames: skuRenames,
  });
};
