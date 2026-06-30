// Smoke test for the ShipHero on-hand integration. Authenticates, resolves the
// Apex warehouse, pulls on-hand by SKU, and prints a sample. Use this to verify
// credentials + that the warehouse name and query shape match the live API.
//
// Run: npx tsx --env-file=.env scripts/test-shiphero.ts

import { getApexWarehouseId, getOnHandInventory } from "../app/utils/shiphero.server";

async function main() {
  console.log("Resolving Apex warehouse id...");
  const warehouseId = await getApexWarehouseId();
  console.log("  warehouse id:", warehouseId);

  console.log("Fetching on-hand inventory...");
  const onHand = await getOnHandInventory();
  console.log(`  ${onHand.size} SKUs returned`);

  const sample = [...onHand.entries()]
    .filter(([, qty]) => qty > 0)
    .slice(0, 15);
  console.log("\nSample (first 15 with on_hand > 0):");
  for (const [sku, qty] of sample) {
    console.log(`  ${sku.padEnd(24)} ${qty}`);
  }

  const total = [...onHand.values()].reduce((a, b) => a + b, 0);
  console.log(`\nTotal units on hand across all SKUs: ${total}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nShipHero test failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
