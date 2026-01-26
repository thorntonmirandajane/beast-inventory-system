import prisma from "./app/db.server.ts";

async function resetAssemblies() {
  console.log("\n=== Resetting All ASSEMBLED and COMPLETED Inventory to 0 ===\n");

  // Delete all ASSEMBLED and COMPLETED inventory items
  const deleteResult = await prisma.inventoryItem.deleteMany({
    where: {
      state: { in: ["ASSEMBLED", "COMPLETED"] },
    },
  });

  console.log(`✓ Deleted ${deleteResult.count} ASSEMBLED/COMPLETED inventory items\n`);

  // Verify by checking what's left
  const remaining = await prisma.inventoryItem.findMany({
    where: {
      state: { in: ["ASSEMBLED", "COMPLETED"] },
      quantity: { gt: 0 },
    },
    include: {
      sku: { select: { sku: true, type: true } },
    },
  });

  if (remaining.length === 0) {
    console.log("✓ Confirmed: No ASSEMBLED or COMPLETED inventory remaining\n");
  } else {
    console.log(`⚠️ Warning: Found ${remaining.length} remaining items:\n`);
    remaining.forEach((item) => {
      console.log(`  ${item.sku.sku} (${item.sku.type}): ${item.quantity} in ${item.state} state`);
    });
  }

  console.log("\n=== Reset Complete ===\n");
  console.log("Now refresh the inventory page - 'In Assembly' column should show 0 for all RAW materials");
}

resetAssemblies()
  .catch((e) => {
    console.error("Error:", e);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
