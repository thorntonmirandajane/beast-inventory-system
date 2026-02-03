import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

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

async function main() {
  console.log("Starting COC/CB SKU rename...");

  let renamed = 0;
  let alreadyRenamed = 0;
  let notFound = 0;

  for (const { oldSku, newSku } of skuRenames) {
    const existing = await prisma.sku.findUnique({ where: { sku: oldSku } });

    if (!existing) {
      // Check if new SKU already exists (already renamed)
      const newExists = await prisma.sku.findUnique({ where: { sku: newSku } });
      if (newExists) {
        alreadyRenamed++;
      } else {
        notFound++;
        console.log(`  Not found: ${oldSku}`);
      }
      continue;
    }

    // Check for conflict with new name
    const conflict = await prisma.sku.findUnique({ where: { sku: newSku } });
    if (conflict) {
      console.log(`  Conflict: ${oldSku} -> ${newSku}`);
      alreadyRenamed++;
      continue;
    }

    await prisma.sku.update({
      where: { sku: oldSku },
      data: { sku: newSku },
    });
    console.log(`  Renamed: ${oldSku} -> ${newSku}`);
    renamed++;
  }

  console.log(`\nCOC/CB SKU rename complete:`);
  console.log(`  Renamed: ${renamed}`);
  console.log(`  Already renamed: ${alreadyRenamed}`);
  console.log(`  Not found: ${notFound}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  prisma.$disconnect();
  process.exit(1);
});
