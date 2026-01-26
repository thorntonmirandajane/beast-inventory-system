import prisma from "./app/db.server.ts";
import { autoDeductRawMaterials } from "./app/utils/inventory.server.ts";

async function testFullWorkflow() {
  console.log("\n=== Full Inventory Workflow Test ===\n");

  // Step 1: Reset all RAW to 1000
  console.log("Step 1: Resetting all RAW materials to 1000...");
  await prisma.inventoryItem.updateMany({
    where: { state: "RAW" },
    data: { quantity: 1000 },
  });

  // Step 2: Delete all ASSEMBLED and COMPLETED inventory
  console.log("Step 2: Clearing all ASSEMBLED and COMPLETED inventory...");
  await prisma.inventoryItem.deleteMany({
    where: { state: { in: ["ASSEMBLED", "COMPLETED"] } },
  });

  console.log("\n=== Adding 10 to Tip [Steel] (ASSEMBLY type) ===\n");

  // Step 3: Find Tip [Steel] SKU
  const tipSteel = await prisma.sku.findFirst({
    where: { sku: "TIP-STEEL" },
  });

  if (!tipSteel) {
    console.log("TIP-STEEL not found!");
    return;
  }

  console.log(`Found: ${tipSteel.sku} (type: ${tipSteel.type})`);

  // Step 4: Add 10 to ASSEMBLED state
  await prisma.inventoryItem.create({
    data: {
      skuId: tipSteel.id,
      state: "ASSEMBLED",
      quantity: 10,
    },
  });

  console.log("✓ Added 10 to ASSEMBLED state");

  // Step 5: Trigger auto-deduction
  console.log("\nTriggering auto-deduction...");
  const deductResult = await autoDeductRawMaterials(tipSteel.id, 10);

  console.log(`Success: ${deductResult.success}`);
  if (!deductResult.success) {
    console.log(`Error: ${deductResult.error}`);
  }

  console.log(`\nDeducted ${deductResult.deducted.length} raw materials:`);
  for (const item of deductResult.deducted) {
    console.log(`  ${item.sku}: -${item.quantity}`);
  }

  // Step 6: Check TIP-STEEL inventory
  console.log("\n=== Checking TIP-STEEL Raw Material ===");
  const tipSteelInv = await prisma.inventoryItem.findFirst({
    where: { skuId: tipSteel.id, state: "RAW" },
  });

  const expectedQty = 1000 - (10 * 190); // TIP-STEEL BOM shows 190 in "Total from both"
  console.log(`TIP-STEEL RAW inventory: ${tipSteelInv?.quantity || 0} (expected: ${expectedQty})`);

  // Step 7: Check what the "In Assembly" calculation would show
  console.log("\n=== Calculating 'In Assembly' for TIP-STEEL ===");

  const assembliesUsingTipSteel = await prisma.sku.findMany({
    where: {
      type: { in: ["ASSEMBLY", "COMPLETED"] },
      bomComponents: {
        some: {
          componentSkuId: tipSteel.id,
        },
      },
    },
    include: {
      bomComponents: {
        where: { componentSkuId: tipSteel.id },
      },
      inventoryItems: {
        where: { state: { in: ["ASSEMBLED", "COMPLETED"] } },
      },
    },
  });

  let totalInAssembly = 0;
  for (const assembly of assembliesUsingTipSteel) {
    const assembledQty = assembly.inventoryItems.reduce((sum, item) => sum + item.quantity, 0);
    const qtyPerUnit = assembly.bomComponents[0]?.quantity || 0;
    const locked = assembledQty * qtyPerUnit;
    totalInAssembly += locked;

    if (locked > 0) {
      console.log(`  ${assembly.sku}: ${assembledQty} assembled × ${qtyPerUnit} per unit = ${locked} locked`);
    }
  }

  console.log(`\nTotal TIP-STEEL 'In Assembly': ${totalInAssembly} (expected: 190 from spreadsheet)`);
}

testFullWorkflow()
  .catch((e) => {
    console.error("Error:", e);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
