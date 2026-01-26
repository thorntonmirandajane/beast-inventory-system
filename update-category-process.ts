import prisma from "./app/db.server.ts";

// Mapping from CSV: SKU -> { process, category }
const skuMapping: Record<string, { process: string; category: string }> = {
  "TI-100-TIPPED-FERRULE": { process: "Tipped", category: "Titanium (100g)" },
  "TI-2IN-100G-BLADED-FERRULE": { process: "Bladed", category: "Titanium (100g)" },
  "TI-2IN-100G-BEAST": { process: "Stud Tested", category: "Titanium (100g)" },
  "TI-3PACK-100g-2.0in": { process: "Completed Packs", category: "Titanium (100g)" },
  "TI-23IN-100G-BLADED-FERRULE": { process: "Bladed", category: "Titanium (100g)" },
  "TI-23IN-100G-BEAST": { process: "Stud Tested", category: "Titanium (100g)" },
  "TI-3PACK-100g-2.3in": { process: "Completed Packs", category: "Titanium (100g)" },
  "TI-TIPPED-FERRULE": { process: "Tipped", category: "Titanium (125g)" },
  "TI-2IN-BLADED-FERRULE": { process: "Bladed", category: "Titanium (125g)" },
  "TI-2IN-125G-BEAST": { process: "Stud Tested", category: "Titanium (125g)" },
  "TI-2PACK-125g-2.0in": { process: "Completed Packs", category: "Titanium (125g)" },
  "TI-3PACK-125g-2.0in": { process: "Completed Packs", category: "Titanium (125g)" },
  "TI-23IN-BLADED-FERRULE": { process: "Bladed", category: "Titanium (125g)" },
  "TI-23IN-125G-BEAST": { process: "Stud Tested", category: "Titanium (125g)" },
  "TI-3PACK-125g-2.3in": { process: "Completed Packs", category: "Titanium (125g)" },
  "TIPPED-FERRULE": { process: "Tipped", category: "Aluminum" },
  "23IN-BLADED-FERRULE": { process: "Bladed", category: "Aluminum" },
  "23IN-100G-BEAST": { process: "Stud Tested", category: "Aluminum" },
  "2PACK-100g-2.3in": { process: "Completed Packs", category: "Aluminum" },
  "3PACK-100g-2.3in": { process: "Completed Packs", category: "Aluminum" },
  "23IN-125G-BEAST": { process: "Stud Tested", category: "Aluminum" },
  "2PACK-125g-2.3in": { process: "Completed Packs", category: "Aluminum" },
  "3PACK-125g-2.3in": { process: "Completed Packs", category: "Aluminum" },
  "D6-23IN-100G-BEAST": { process: "Stud Tested", category: "Aluminum" },
  "D6-3PACK-100g-2.3in": { process: "Completed Packs", category: "Aluminum" },
  "D6-23IN-125G-BEAST": { process: "Stud Tested", category: "Aluminum" },
  "D6-3PACK-125g-2.3in": { process: "Completed Packs", category: "Aluminum" },
  "2IN-BLADED-FERRULE": { process: "Bladed", category: "Aluminum" },
  "2IN-100G-BEAST": { process: "Stud Tested", category: "Aluminum" },
  "2PACK-100g-2.0in": { process: "Completed Packs", category: "Aluminum" },
  "3PACK-100g-2.0in": { process: "Completed Packs", category: "Aluminum" },
  "2IN-125G-BEAST": { process: "Stud Tested", category: "Aluminum" },
  "2PACK-125g-2.0in": { process: "Completed Packs", category: "Aluminum" },
  "3PACK-125g-2.0in": { process: "Completed Packs", category: "Aluminum" },
  "D6-2IN-100G-BEAST": { process: "Stud Tested", category: "Aluminum" },
  "D6-3PACK-100g-2.0in": { process: "Completed Packs", category: "Aluminum" },
  "D6-2IN-125G-BEAST": { process: "Stud Tested", category: "Aluminum" },
  "D6-3PACK-125g-2.0in": { process: "Completed Packs", category: "Aluminum" },
  "ST-TIPPED-FERRULE": { process: "Tipped", category: "Steel" },
  "ST-2IN-BLADED-FERRULE": { process: "Bladed", category: "Steel" },
  "ST-2IN-150G-BEAST": { process: "Stud Tested", category: "Steel" },
  "3PACK-150g-2.0in": { process: "Completed Packs", category: "Steel" },
  "TR-TIPPED-FERRULE": { process: "Tipped", category: "TRUMP" },
  "TR-2IN-BLADED-FERRULE": { process: "Bladed", category: "TRUMP" },
  "TR-2IN-100G-BEAST": { process: "Completed Packs", category: "TRUMP" }, // Note: Listed twice in CSV
  "TR-2IN-125G-BEAST": { process: "Completed Packs", category: "TRUMP" }, // Note: Listed twice in CSV
  "TR-23IN-BLADED-FERRULE": { process: "Bladed", category: "TRUMP" },
  "TR-23IN-100G-BEAST": { process: "Completed Packs", category: "TRUMP" }, // Note: Listed twice in CSV
  "TR-23IN-125G-BEAST": { process: "Completed Packs", category: "TRUMP" }, // Note: Listed twice in CSV
  "3PACK-PT-100G": { process: "Completed Packs", category: "PRACTICE TIPS" },
  "3PACK-PT-125G": { process: "Completed Packs", category: "PRACTICE TIPS" },
};

async function updateCategoryProcess() {
  console.log("\n=== Updating Category and Process Fields ===\n");

  const allSkus = await prisma.sku.findMany({
    where: { isActive: true },
    select: { id: true, sku: true, category: true, material: true },
  });

  let updated = 0;
  let notFound = 0;

  for (const skuRecord of allSkus) {
    const mapping = skuMapping[skuRecord.sku];

    if (mapping) {
      // Update: category field = material (Aluminum, Titanium, etc.)
      //         material field = process (Tipped, Bladed, etc.)
      await prisma.sku.update({
        where: { id: skuRecord.id },
        data: {
          material: mapping.process,     // "material" field stores process
          category: mapping.category,    // "category" field stores category
        },
      });

      console.log(`✓ Updated ${skuRecord.sku}: Process="${mapping.process}", Category="${mapping.category}"`);
      updated++;
    } else {
      // Not in mapping - set to N/A
      await prisma.sku.update({
        where: { id: skuRecord.id },
        data: {
          material: null,
          category: null,
        },
      });

      console.log(`⚠ ${skuRecord.sku}: Not in CSV, set to N/A`);
      notFound++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Updated: ${updated}`);
  console.log(`Not in CSV (set to N/A): ${notFound}`);
  console.log(`Total: ${allSkus.length}\n`);
}

updateCategoryProcess()
  .catch((e) => {
    console.error("Error:", e);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
