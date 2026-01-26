import prisma from "./app/db.server.ts";

async function checkAssembled() {
  const items = await prisma.inventoryItem.findMany({
    where: {
      state: { in: ["ASSEMBLED", "COMPLETED"] },
      quantity: { gt: 0 },
    },
    include: {
      sku: { select: { sku: true, type: true } },
    },
  });

  console.log(`\nFound ${items.length} ASSEMBLED/COMPLETED items with quantity > 0:\n`);
  items.forEach((i) =>
    console.log(`  ${i.sku.sku} (${i.sku.type}): ${i.quantity} in ${i.state} state`)
  );

  if (items.length === 0) {
    console.log("  (none - all are at 0)");
  }
}

checkAssembled()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
