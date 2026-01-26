import prisma from "./app/db.server.ts";

async function checkMappings() {
  console.log("\n=== Current Database Mappings ===\n");

  const skus = await prisma.sku.findMany({
    where: {
      isActive: true,
      OR: [
        { type: "ASSEMBLY" },
        { type: "COMPLETED" }
      ]
    },
    select: {
      sku: true,
      material: true,  // This stores PROCESS
      category: true,  // This stores CATEGORY
      type: true
    },
    orderBy: { sku: "asc" },
  });

  console.log("SKU | Process (material field) | Category (category field) | Type");
  console.log("-".repeat(100));

  for (const sku of skus) {
    console.log(`${sku.sku.padEnd(30)} | ${(sku.material || "N/A").padEnd(20)} | ${(sku.category || "N/A").padEnd(20)} | ${sku.type}`);
  }

  console.log(`\nTotal: ${skus.length} SKUs\n`);
}

checkMappings()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
