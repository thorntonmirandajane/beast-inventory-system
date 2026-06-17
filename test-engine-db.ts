// DB-backed verification of the production engine + opening-count uploader.
// Safe & self-cleaning: it uses its own "__VERIFY_*" SKUs and deletes them at
// the end. It does NOT touch any real inventory. Still, prefer a non-prod DB.
//
// Run:  node --env-file=.env test-engine-db.ts
//   (or)  DATABASE_URL="postgresql://..." node test-engine-db.ts
//
// Verifies, against a real Postgres:
//   1. applyOpeningCounts() sets absolute counts + logs ADJUSTED (dry-run vs apply)
//   2. applyProduction() consumes IMMEDIATE BOM children only (no double-deduct)
//   3. a multi-stage run nets WIP to zero and never re-consumes upstream raws
//   4. negative stock produces a warning (not a silent drift)

import prisma from "./app/db.server.ts";
import {
  applyOpeningCounts,
  applyProduction,
  getAvailableQuantity,
} from "./app/utils/inventory.server.ts";

const P = "__VERIFY_"; // prefix so we never collide with real SKUs
let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  if (!cond) failures++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` (${extra})` : ""}`);
}

async function id(sku: string) {
  const row = await prisma.sku.findUnique({ where: { sku: sku } });
  return row!.id;
}
async function qty(sku: string, state: "RAW" | "ASSEMBLED" | "COMPLETED") {
  return getAvailableQuantity(await id(sku), [state]);
}

async function main() {
  // ---- setup: test SKUs + BOM -------------------------------------------
  const skus: { sku: string; type: "RAW" | "ASSEMBLY" | "COMPLETED" }[] = [
    { sku: `${P}FERRULE`, type: "RAW" },
    { sku: `${P}TIP`, type: "RAW" },
    { sku: `${P}BLADE`, type: "RAW" },
    { sku: `${P}PIN`, type: "RAW" },
    { sku: `${P}TIPPED`, type: "ASSEMBLY" },
    { sku: `${P}BLADED`, type: "ASSEMBLY" },
  ];
  for (const s of skus) {
    await prisma.sku.upsert({
      where: { sku: s.sku },
      update: { type: s.type, isActive: true },
      create: { sku: s.sku, name: s.sku, type: s.type },
    });
  }
  const bom = async (parent: string, comps: { sku: string; qty: number }[]) => {
    const parentId = await id(parent);
    for (const c of comps) {
      await prisma.bomComponent.upsert({
        where: { parentSkuId_componentSkuId: { parentSkuId: parentId, componentSkuId: await id(c.sku) } },
        update: { quantity: c.qty },
        create: { parentSkuId: parentId, componentSkuId: await id(c.sku), quantity: c.qty },
      });
    }
  };
  await bom(`${P}TIPPED`, [{ sku: `${P}FERRULE`, qty: 1 }, { sku: `${P}TIP`, qty: 1 }]);
  await bom(`${P}BLADED`, [{ sku: `${P}TIPPED`, qty: 1 }, { sku: `${P}BLADE`, qty: 2 }, { sku: `${P}PIN`, qty: 1 }]);

  // ---- 1. opening counts: dry-run then apply ----------------------------
  const rows = [
    { sku: `${P}FERRULE`, qty: 100 },
    { sku: `${P}TIP`, qty: 100 },
    { sku: `${P}BLADE`, qty: 200 },
    { sku: `${P}PIN`, qty: 100 },
    { sku: `${P}NOPE`, qty: 5 }, // unknown SKU
  ];
  const preview = await applyOpeningCounts(rows, undefined, { dryRun: true });
  console.log("\n1) applyOpeningCounts:");
  check("dry-run flags the unknown SKU", preview.unknownSkus.length === 1);
  check("dry-run did NOT write (ferrule still 0)", (await qty(`${P}FERRULE`, "RAW")) === 0);
  await applyOpeningCounts(rows, undefined, { dryRun: false });
  check("apply sets FERRULE RAW = 100", (await qty(`${P}FERRULE`, "RAW")) === 100);
  check("apply sets BLADE RAW = 200", (await qty(`${P}BLADE`, "RAW")) === 200);
  const adjLogs = await prisma.inventoryLog.count({
    where: { action: "ADJUSTED", relatedResourceType: "OPENING_COUNT", skuId: await id(`${P}FERRULE`) },
  });
  check("apply logged an ADJUSTED entry", adjLogs >= 1);

  // ---- 2 & 3. production: single-level, no double-deduct -----------------
  console.log("\n2) applyProduction — tip 100, then blade 100:");
  await applyProduction(await id(`${P}TIPPED`), 100, { processName: "TIPPING" });
  check("FERRULE consumed once -> 0", (await qty(`${P}FERRULE`, "RAW")) === 0);
  check("TIP consumed once -> 0", (await qty(`${P}TIP`, "RAW")) === 0);
  check("TIPPED produced -> 100", (await qty(`${P}TIPPED`, "ASSEMBLED")) === 100);

  await applyProduction(await id(`${P}BLADED`), 100, { processName: "BLADING" });
  check("TIPPED consumed by blading -> 0 (no phantom WIP)", (await qty(`${P}TIPPED`, "ASSEMBLED")) === 0);
  check("BLADE consumed 2x -> 0", (await qty(`${P}BLADE`, "RAW")) === 0);
  check("PIN consumed -> 0", (await qty(`${P}PIN`, "RAW")) === 0);
  check("FERRULE NOT re-consumed by blading (still 0, not -100)", (await qty(`${P}FERRULE`, "RAW")) === 0);
  check("BLADED produced -> 100", (await qty(`${P}BLADED`, "ASSEMBLED")) === 100);

  // ---- 4. negative produces a warning -----------------------------------
  console.log("\n3) negative-stock warning:");
  const over = await applyProduction(await id(`${P}BLADED`), 50, { processName: "BLADING" });
  check("going negative returns a warning", over.warnings.length > 0, over.warnings.join("; "));

  console.log(`\n${failures === 0 ? "✅ ALL DB CHECKS PASSED" : `❌ ${failures} FAILURE(S)`}`);
}

async function cleanup() {
  const ids = (
    await prisma.sku.findMany({ where: { sku: { startsWith: P } }, select: { id: true } })
  ).map((s) => s.id);
  if (ids.length) {
    await prisma.inventoryLog.deleteMany({ where: { skuId: { in: ids } } });
    await prisma.inventoryItem.deleteMany({ where: { skuId: { in: ids } } });
    await prisma.bomComponent.deleteMany({
      where: { OR: [{ parentSkuId: { in: ids } }, { componentSkuId: { in: ids } }] },
    });
    await prisma.sku.deleteMany({ where: { id: { in: ids } } });
  }
  console.log(`\n(cleaned up ${ids.length} test SKUs)`);
}

main()
  .catch((e) => {
    console.error("ERROR:", e);
    failures++;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  });
