import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Data from CSV - Column B (PROCESS) and Column C (CATAGORY)
const skuData: { sku: string; process: string; category: string }[] = [
  { sku: "TI-100-TIPPED-FERRULE", process: "Tipped", category: "Titanium (100g)" },
  { sku: "TI-2IN-100G-BLADED-FERRULE", process: "Bladed", category: "Titanium (100g)" },
  { sku: "TI-2IN-100G-BEAST", process: "Stud Tested", category: "Titanium (100g)" },
  { sku: "TI-3PACK-100g-2.0in", process: "Completed Packs", category: "Titanium (100g)" },
  { sku: "TI-23IN-100G-BLADED-FERRULE", process: "Bladed", category: "Titanium (100g)" },
  { sku: "TI-23IN-100G-BEAST", process: "Stud Tested", category: "Titanium (100g)" },
  { sku: "TI-3PACK-100g-2.3in", process: "Completed Packs", category: "Titanium (100g)" },
  { sku: "TI-TIPPED-FERRULE", process: "Tipped", category: "Titanium (125g)" },
  { sku: "TI-2IN-BLADED-FERRULE", process: "Bladed", category: "Titanium (125g)" },
  { sku: "TI-2IN-125G-BEAST", process: "Stud Tested", category: "Titanium (125g)" },
  { sku: "TI-2PACK-125g-2.0in", process: "Completed Packs", category: "Titanium (125g)" },
  { sku: "TI-3PACK-125g-2.0in", process: "Completed Packs", category: "Titanium (125g)" },
  { sku: "TI-23IN-BLADED-FERRULE", process: "Bladed", category: "Titanium (125g)" },
  { sku: "TI-23IN-125G-BEAST", process: "Stud Tested", category: "Titanium (125g)" },
  { sku: "TI-3PACK-125g-2.3in", process: "Completed Packs", category: "Titanium (125g)" },
  { sku: "TIPPED-FERRULE", process: "Tipped", category: "Aluminum" },
  { sku: "23IN-BLADED-FERRULE", process: "Bladed", category: "Aluminum" },
  { sku: "23IN-100G-BEAST", process: "Stud Tested", category: "Aluminum" },
  { sku: "2PACK-100g-2.3in", process: "Completed Packs", category: "Aluminum" },
  { sku: "3PACK-100g-2.3in", process: "Completed Packs", category: "Aluminum" },
  { sku: "23IN-125G-BEAST", process: "Stud Tested", category: "Aluminum" },
  { sku: "2PACK-125g-2.3in", process: "Completed Packs", category: "Aluminum" },
  { sku: "3PACK-125g-2.3in", process: "Completed Packs", category: "Aluminum" },
  { sku: "D6-23IN-100G-BEAST", process: "Stud Tested", category: "Aluminum" },
  { sku: "D6-3PACK-100g-2.3in", process: "Completed Packs", category: "Aluminum" },
  { sku: "D6-23IN-125G-BEAST", process: "Stud Tested", category: "Aluminum" },
  { sku: "D6-3PACK-125g-2.3in", process: "Completed Packs", category: "Aluminum" },
  { sku: "2IN-BLADED-FERRULE", process: "Bladed", category: "Aluminum" },
  { sku: "2IN-100G-BEAST", process: "Stud Tested", category: "Aluminum" },
  { sku: "2PACK-100g-2.0in", process: "Completed Packs", category: "Aluminum" },
  { sku: "3PACK-100g-2.0in", process: "Completed Packs", category: "Aluminum" },
  { sku: "2IN-125G-BEAST", process: "Stud Tested", category: "Aluminum" },
  { sku: "2PACK-125g-2.0in", process: "Completed Packs", category: "Aluminum" },
  { sku: "3PACK-125g-2.0in", process: "Completed Packs", category: "Aluminum" },
  { sku: "D6-2IN-100G-BEAST", process: "Stud Tested", category: "Aluminum" },
  { sku: "D6-3PACK-100g-2.0in", process: "Completed Packs", category: "Aluminum" },
  { sku: "D6-2IN-125G-BEAST", process: "Stud Tested", category: "Aluminum" },
  { sku: "D6-3PACK-125g-2.0in", process: "Completed Packs", category: "Aluminum" },
  { sku: "ST-TIPPED-FERRULE", process: "Tipped", category: "Steel" },
  { sku: "ST-2IN-BLADED-FERRULE", process: "Bladed", category: "Steel" },
  { sku: "ST-2IN-150G-BEAST", process: "Stud Tested", category: "Steel" },
  { sku: "3PACK-150g-2.0in", process: "Completed Packs", category: "Steel" },
  { sku: "TR-TIPPED-FERRULE", process: "Tipped", category: "TRUMP" },
  { sku: "TR-2IN-BLADED-FERRULE", process: "Bladed", category: "TRUMP" },
  { sku: "TR-2IN-100G-BEAST", process: "Stud Tested", category: "TRUMP" },
  { sku: "TR-2IN-125G-BEAST", process: "Stud Tested", category: "TRUMP" },
  { sku: "TR-23IN-BLADED-FERRULE", process: "Bladed", category: "TRUMP" },
  { sku: "TR-23IN-100G-BEAST", process: "Stud Tested", category: "TRUMP" },
  { sku: "TR-23IN-125G-BEAST", process: "Stud Tested", category: "TRUMP" },
  { sku: "3PACK-PT-100G", process: "Completed Packs", category: "PRACTICE TIPS" },
  { sku: "3PACK-PT-125G", process: "Completed Packs", category: "PRACTICE TIPS" },
];

async function updateSkuProcessCategory() {
  console.log("Updating SKU process and category values...\n");

  let updated = 0;
  let notFound = 0;

  for (const item of skuData) {
    const result = await prisma.sku.updateMany({
      where: { sku: item.sku },
      data: {
        material: item.process,   // "material" field stores Process (Tipped, Bladed, etc.)
        category: item.category,  // "category" field stores Category (Aluminum, Titanium, etc.)
      },
    });

    if (result.count > 0) {
      console.log(`✅ ${item.sku}: Process="${item.process}", Category="${item.category}"`);
      updated++;
    } else {
      console.log(`⚠️  SKU not found: ${item.sku}`);
      notFound++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`✅ Updated: ${updated}`);
  console.log(`⚠️  Not found: ${notFound}`);
  console.log(`📊 Total processed: ${skuData.length}`);
}

updateSkuProcessCategory()
  .then(() => {
    console.log("\n✨ Update completed!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
