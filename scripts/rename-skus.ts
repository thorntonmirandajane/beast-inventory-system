import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Old SKU -> New SKU mapping from CSV
const skuRenames: { oldSku: string; newSku: string }[] = [
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

async function renameSkus() {
  console.log("Renaming SKUs...\n");

  let renamed = 0;
  let notFound = 0;
  let alreadyExists = 0;

  for (const { oldSku, newSku } of skuRenames) {
    // Check if old SKU exists
    const existing = await prisma.sku.findUnique({
      where: { sku: oldSku },
    });

    if (!existing) {
      // Check if the new SKU already exists (already renamed)
      const newExists = await prisma.sku.findUnique({
        where: { sku: newSku },
      });

      if (newExists) {
        console.log(`⏭️  ${oldSku} -> ${newSku} (already renamed)`);
        alreadyExists++;
      } else {
        console.log(`⚠️  ${oldSku} not found`);
        notFound++;
      }
      continue;
    }

    // Check if new SKU already exists (would cause conflict)
    const conflict = await prisma.sku.findUnique({
      where: { sku: newSku },
    });

    if (conflict) {
      console.log(`❌ Cannot rename ${oldSku} -> ${newSku} (new SKU already exists)`);
      continue;
    }

    // Rename the SKU
    await prisma.sku.update({
      where: { sku: oldSku },
      data: { sku: newSku },
    });

    console.log(`✅ ${oldSku} -> ${newSku}`);
    renamed++;
  }

  console.log(`\n=== Summary ===`);
  console.log(`✅ Renamed: ${renamed}`);
  console.log(`⏭️  Already renamed: ${alreadyExists}`);
  console.log(`⚠️  Not found: ${notFound}`);
}

renameSkus()
  .then(() => {
    console.log("\n✨ SKU rename completed!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
