// Smoke test for the ShipHero on-hand integration. Authenticates, resolves the
// Apex warehouse, then pulls on-hand for beast's own SKUs (batched per-SKU, not
// a full warehouse scan) and prints a sample. Use this to verify credentials +
// that the warehouse name and query shape match the live API.
//
// Run: npx tsx --env-file=.env scripts/test-shiphero.ts

import prisma from "../app/db.server";
import { getApexWarehouseId, getOnHandForSkus } from "../app/utils/shiphero.server";

async function main() {
  console.log("Resolving Apex warehouse id...");
  const warehouseId = await getApexWarehouseId();
  console.log("  warehouse id:", warehouseId);

  const skus = await prisma.sku.findMany({
    where: { isActive: true, type: { in: ["RAW", "ASSEMBLY", "COMPLETED"] } },
    select: { sku: true },
    orderBy: { sku: "asc" },
  });
  console.log(`\nFetching on-hand for ${skus.length} beast SKUs...`);
  const t0 = Date.now();
  const onHand = await getOnHandForSkus(skus.map((s) => s.sku));
  console.log(`  done in ${(Date.now() - t0) / 1000}s, ${onHand.size} SKUs returned`);

  const nonZero = [...onHand.entries()].filter(([, q]) => q > 0);
  console.log(`\nSKUs with on_hand > 0 (${nonZero.length}):`);
  for (const [sku, qty] of nonZero.slice(0, 20)) {
    console.log(`  ${sku.padEnd(28)} ${qty}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nShipHero test failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
