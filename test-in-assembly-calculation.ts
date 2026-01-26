import prisma from "./app/db.server.ts";

async function testInAssemblyCalculation() {
  console.log("\n=== Testing In Assembly Calculation ===\n");

  // Replicate the exact logic from inventory.tsx loader
  const inAssemblyBySkuId: Record<string, number> = {};

  // Helper function to recursively explode BOM and accumulate raw material usage
  async function explodeBOMForInAssembly(
    skuId: string,
    quantity: number,
    accumulated: Record<string, number>
  ): Promise<void> {
    const sku = await prisma.sku.findUnique({
      where: { id: skuId },
      include: {
        bomComponents: {
          include: {
            componentSku: true,
          },
        },
      },
    });

    if (!sku) return;

    // If this is a RAW material, add it to the accumulated map
    if (sku.type === "RAW") {
      if (!accumulated[skuId]) {
        accumulated[skuId] = 0;
      }
      accumulated[skuId] += quantity;
      return;
    }

    // If this is an ASSEMBLY or COMPLETED, recursively process its components
    if (sku.type === "ASSEMBLY" || sku.type === "COMPLETED") {
      for (const bomItem of sku.bomComponents) {
        const requiredQty = bomItem.quantity * quantity;
        await explodeBOMForInAssembly(bomItem.componentSkuId, requiredQty, accumulated);
      }
    }
  }

  // Get all SKUs with their assembled inventory
  const skusWithBoms = await prisma.sku.findMany({
    where: { isActive: true, type: { in: ["ASSEMBLY", "COMPLETED"] } },
    include: {
      inventoryItems: {
        where: { state: { in: ["ASSEMBLED", "COMPLETED"] } },
      },
    },
  });

  console.log(`Found ${skusWithBoms.length} assembled/completed SKUs\n`);

  // For each assembled/completed product, recursively calculate raw material usage
  for (const sku of skusWithBoms) {
    const assembledQty = sku.inventoryItems.reduce((sum, item) => sum + item.quantity, 0);

    if (assembledQty > 0) {
      console.log(`Processing ${sku.sku}: ${assembledQty} units`);
      // Recursively explode the BOM to get ALL raw materials
      await explodeBOMForInAssembly(sku.id, assembledQty, inAssemblyBySkuId);
    }
  }

  console.log(`\n\nFinal inAssemblyBySkuId map has ${Object.keys(inAssemblyBySkuId).length} entries\n`);

  // Now test lookup for BLADE-2IN
  const blade2in = await prisma.sku.findFirst({ where: { sku: "BLADE-2IN" } });
  if (blade2in) {
    const inAssemblyValue = inAssemblyBySkuId[blade2in.id];
    console.log(`BLADE-2IN:`);
    console.log(`  ID: ${blade2in.id}`);
    console.log(`  In Assembly: ${inAssemblyValue || "NOT IN MAP"}`);
    console.log(`  Expected: Should be > 0 (probably around 940)`);

    // Check if the ID is in the keys
    const isInKeys = Object.keys(inAssemblyBySkuId).includes(blade2in.id);
    console.log(`  ID in map keys: ${isInKeys}`);

    if (!isInKeys) {
      console.log(`\n  ⚠️ BLADE-2IN ID not found in map!`);
      console.log(`  Sample map keys:`, Object.keys(inAssemblyBySkuId).slice(0, 10));
    }
  }

  // Show all entries
  console.log(`\n\nAll In Assembly values:`);
  for (const [skuId, qty] of Object.entries(inAssemblyBySkuId).slice(0, 20)) {
    const sku = await prisma.sku.findUnique({ where: { id: skuId }, select: { sku: true } });
    console.log(`  ${sku?.sku}: ${qty}`);
  }
}

testInAssemblyCalculation()
  .catch((e) => {
    console.error("Error:", e);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
