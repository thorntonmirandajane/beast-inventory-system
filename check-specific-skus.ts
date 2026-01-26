import prisma from "./app/db.server.ts";

async function checkSkus() {
  const skus = await prisma.sku.findMany({
    where: {
      sku: { in: ['23IN-100G-BEAST', '2IN-100G-BEAST', '2PACK-100g-2.0in', '3PACK-100g-2.0in'] }
    },
    select: {
      sku: true,
      material: true,
      category: true,
    },
    orderBy: { sku: 'asc' }
  });

  console.log("\nCurrent database values:");
  console.log("SKU | material (should be Process) | category (should be Category)");
  console.log("-".repeat(80));

  for (const sku of skus) {
    console.log(`${sku.sku.padEnd(25)} | ${(sku.material || 'NULL').padEnd(25)} | ${sku.category || 'NULL'}`);
  }
}

checkSkus()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
