import prisma from "./app/db.server.ts";
import { autoDeductRawMaterials } from "./app/utils/inventory.server.ts";

async function testWithAssembly() {
  console.log("\n=== Testing with an actual ASSEMBLY product ===\n");

  // Reset all RAW to 1000
  await prisma.inventoryItem.updateMany({
    where: { state: "RAW" },
    data: { quantity: 1000 },
  });

  // Clear ASSEMBLED/COMPLETED
  await prisma.inventoryItem.deleteMany({
    where: { state: { in: ["ASSEMBLED", "COMPLETED"] } },
  });

  // Find a COMPLETED product
  const completedProduct = await prisma.sku.findFirst({
    where: { type: "COMPLETED", isActive: true },
    include: {
      bomComponents: {
        include: {
          componentSku: true,
        },
      },
    },
  });

  if (!completedProduct) {
    console.log("No COMPLETED products found!");
    return;
  }

  console.log(`Testing with: ${completedProduct.sku} (${completedProduct.type})`);
  console.log(`\nBOM (first level):`);
  for (const comp of completedProduct.bomComponents) {
    console.log(`  ${comp.quantity}x ${comp.componentSku.sku} (${comp.componentSku.type})`);
  }

  // Add 10 to COMPLETED
  console.log(`\nAdding 10 to COMPLETED state...`);
  await prisma.inventoryItem.create({
    data: {
      skuId: completedProduct.id,
      state: "COMPLETED",
      quantity: 10,
    },
  });

  // Trigger auto-deduction
  console.log("\nTriggering auto-deduction...");
  const result = await autoDeductRawMaterials(completedProduct.id, 10);

  console.log(`\nSuccess: ${result.success}`);
  if (!result.success) {
    console.log(`Error: ${result.error}`);
  }

  if (result.deducted.length > 0) {
    console.log(`\nDeducted ${result.deducted.length} raw materials:`);
    const sorted = result.deducted.sort((a, b) => a.sku.localeCompare(b.sku));
    for (const item of sorted) {
      const inv = await prisma.sku.findFirst({ where: { sku: item.sku } });
      if (inv) {
        const invItem = await prisma.inventoryItem.findFirst({
          where: { skuId: inv.id, state: "RAW" },
        });
        const actual = invItem ? invItem.quantity : 0;
        const expected = 1000 - item.quantity;
        console.log(`  ${item.sku}: -${item.quantity} (inventory now: ${actual}, expected: ${expected})`);
      }
    }
  }
}

testWithAssembly()
  .catch((e) => {
    console.error("Error:", e);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
