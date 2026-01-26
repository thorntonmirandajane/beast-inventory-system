import prisma from "./app/db.server.ts";
import { autoDeductRawMaterials } from "./app/utils/inventory.server.ts";

async function testCompleteScenario() {
  console.log("\n=== COMPLETE INVENTORY TEST SCENARIO ===\n");

  // Step 1: Reset all RAW to 1000
  console.log("Step 1: Resetting all RAW materials to 1000...");
  const rawUpdate = await prisma.inventoryItem.updateMany({
    where: { state: "RAW" },
    data: { quantity: 1000 },
  });
  console.log(`✓ Updated ${rawUpdate.count} RAW inventory items to 1000\n`);

  // Step 2: Delete all ASSEMBLED and COMPLETED inventory
  console.log("Step 2: Clearing all ASSEMBLED and COMPLETED inventory...");
  const assembledDelete = await prisma.inventoryItem.deleteMany({
    where: { state: { in: ["ASSEMBLED", "COMPLETED"] } },
  });
  console.log(`✓ Deleted ${assembledDelete.count} ASSEMBLED/COMPLETED inventory items\n`);

  // Step 3: Get all ASSEMBLY and COMPLETED SKUs
  console.log("Step 3: Finding all ASSEMBLY and COMPLETED SKUs...");
  const assemblySKUs = await prisma.sku.findMany({
    where: {
      type: { in: ["ASSEMBLY", "COMPLETED"] },
      isActive: true,
    },
    select: {
      id: true,
      sku: true,
      name: true,
      type: true,
    },
    orderBy: { sku: "asc" },
  });

  console.log(`Found ${assemblySKUs.length} ASSEMBLY/COMPLETED SKUs:\n`);
  assemblySKUs.forEach((s) => console.log(`  - ${s.sku} (${s.type})`));

  // Step 4: Add 10 to each ASSEMBLY and COMPLETED SKU
  console.log("\n\nStep 4: Adding 10 to each ASSEMBLY and COMPLETED SKU...\n");

  for (const sku of assemblySKUs) {
    const appropriateState = sku.type === "COMPLETED" ? "COMPLETED" : "ASSEMBLED";

    console.log(`\n--- Processing ${sku.sku} (${sku.type}) ---`);

    // Add 10 to inventory
    await prisma.inventoryItem.create({
      data: {
        skuId: sku.id,
        state: appropriateState,
        quantity: 10,
      },
    });

    console.log(`✓ Added 10 to ${appropriateState} state`);

    // Trigger auto-deduction
    const deductResult = await autoDeductRawMaterials(sku.id, 10);

    if (!deductResult.success) {
      console.log(`⚠ Deduction failed: ${deductResult.error}`);
    } else if (deductResult.deducted.length === 0) {
      console.log(`⚠ No BOM components configured`);
    } else {
      console.log(`✓ Deducted ${deductResult.deducted.length} raw materials:`);
      for (const item of deductResult.deducted) {
        console.log(`    ${item.sku}: -${item.quantity}`);
      }
    }
  }

  // Step 5: Show final RAW inventory state
  console.log("\n\n=== FINAL RAW INVENTORY STATE ===\n");

  const rawInventory = await prisma.inventoryItem.findMany({
    where: { state: "RAW" },
    include: {
      sku: {
        select: { sku: true, name: true },
      },
    },
    orderBy: {
      sku: { sku: "asc" },
    },
  });

  console.log("RAW Materials (showing only those that changed from 1000):\n");
  for (const item of rawInventory) {
    if (item.quantity !== 1000) {
      console.log(`${item.sku.sku}: ${item.quantity} (started at 1000, deducted ${1000 - item.quantity})`);
    }
  }

  // Step 6: Calculate "In Assembly" for each RAW material
  console.log("\n\n=== CALCULATING 'IN ASSEMBLY' ===\n");

  const allRawSkus = await prisma.sku.findMany({
    where: { type: "RAW", isActive: true },
    select: { id: true, sku: true },
  });

  for (const rawSku of allRawSkus) {
    // Find all assemblies/completed products that use this raw material
    const assembliesUsingThis = await prisma.sku.findMany({
      where: {
        type: { in: ["ASSEMBLY", "COMPLETED"] },
        bomComponents: {
          some: {
            componentSkuId: rawSku.id,
          },
        },
      },
      include: {
        bomComponents: {
          where: { componentSkuId: rawSku.id },
        },
        inventoryItems: {
          where: { state: { in: ["ASSEMBLED", "COMPLETED"] } },
        },
      },
    });

    let totalInAssembly = 0;
    const details: string[] = [];

    for (const assembly of assembliesUsingThis) {
      const assembledQty = assembly.inventoryItems.reduce((sum, item) => sum + item.quantity, 0);
      const qtyPerUnit = assembly.bomComponents[0]?.quantity || 0;
      const locked = assembledQty * qtyPerUnit;
      totalInAssembly += locked;

      if (locked > 0) {
        details.push(`${assembly.sku}: ${assembledQty} units × ${qtyPerUnit}/unit = ${locked}`);
      }
    }

    if (totalInAssembly > 0) {
      console.log(`\n${rawSku.sku}: ${totalInAssembly} in assembly`);
      details.forEach((d) => console.log(`  ${d}`));
    }
  }

  console.log("\n\n=== TEST COMPLETE ===\n");
}

testCompleteScenario()
  .catch((e) => {
    console.error("Error:", e);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
