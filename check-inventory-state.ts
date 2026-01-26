import prisma from "./app/db.server.ts";

async function checkInventoryState() {
  console.log("\n=== Checking Current Inventory State ===\n");

  // Check assembled/completed inventory
  const assembledItems = await prisma.inventoryItem.findMany({
    where: {
      state: { in: ["ASSEMBLED", "COMPLETED"] },
      quantity: { gt: 0 },
    },
    include: {
      sku: {
        select: { sku: true, type: true },
      },
    },
    orderBy: { quantity: "desc" },
  });

  console.log(`Found ${assembledItems.length} ASSEMBLED/COMPLETED inventory items:\n`);
  for (const item of assembledItems.slice(0, 20)) {
    console.log(`  ${item.sku.sku} (${item.sku.type}): ${item.quantity} in ${item.state} state`);
  }

  // Check a specific SKU's BOM
  console.log("\n\n=== Checking 2PACK-100g-2.0in BOM ===\n");
  const sku = await prisma.sku.findFirst({
    where: { sku: "2PACK-100g-2.0in" },
    include: {
      bomComponents: {
        include: {
          componentSku: {
            select: { id: true, sku: true, type: true },
          },
        },
      },
    },
  });

  if (sku) {
    console.log(`${sku.sku} BOM components:`);
    for (const comp of sku.bomComponents) {
      console.log(`  ${comp.componentSku.sku} (${comp.componentSku.type}): ${comp.quantity} per unit`);
    }
  }

  // Test the recursive function manually
  console.log("\n\n=== Testing Recursive BOM Explosion ===\n");

  async function explodeBOM(
    skuId: string,
    quantity: number,
    accumulated: Record<string, number>
  ): Promise<void> {
    const s = await prisma.sku.findUnique({
      where: { id: skuId },
      include: {
        bomComponents: {
          include: {
            componentSku: true,
          },
        },
      },
    });

    if (!s) {
      console.log(`  ⚠️ SKU ${skuId} not found`);
      return;
    }

    console.log(`  Processing ${s.sku} (${s.type}) × ${quantity}`);

    // If this is a RAW material, add it to the accumulated map
    if (s.type === "RAW") {
      if (!accumulated[skuId]) {
        accumulated[skuId] = 0;
      }
      accumulated[skuId] += quantity;
      console.log(`    ✓ Added ${quantity} of ${s.sku} to accumulated (total: ${accumulated[skuId]})`);
      return;
    }

    // If this is an ASSEMBLY or COMPLETED, recursively process its components
    if (s.type === "ASSEMBLY" || s.type === "COMPLETED") {
      console.log(`    Expanding ${s.bomComponents.length} components...`);
      for (const bomItem of s.bomComponents) {
        const requiredQty = bomItem.quantity * quantity;
        await explodeBOM(bomItem.componentSkuId, requiredQty, accumulated);
      }
    }
  }

  if (sku) {
    const accumulated: Record<string, number> = {};
    await explodeBOM(sku.id, 10, accumulated);

    console.log("\n\nFinal accumulated raw materials for 10 × 2PACK-100g-2.0in:");
    for (const [skuId, qty] of Object.entries(accumulated)) {
      const rawSku = await prisma.sku.findUnique({ where: { id: skuId }, select: { sku: true } });
      console.log(`  ${rawSku?.sku}: ${qty}`);
    }
  }
}

checkInventoryState()
  .catch((e) => {
    console.error("Error:", e);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
