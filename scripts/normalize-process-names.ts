/**
 * Normalize SKU material field to use ProcessConfig processName values.
 *
 * Old data has human-readable names like "Stud Tested", "Tipped", "Bladed", "Completed Packs".
 * These should be the enum-style processName values: "STUD_TESTING", "TIPPING", "BLADING", "COMPLETE_PACKS".
 * The displayName in ProcessConfig handles the friendly label for the UI.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const OLD_TO_NEW: Record<string, string> = {
  "Stud Tested": "STUD_TESTING",
  "Stud Testing": "STUD_TESTING",
  "Tipped": "TIPPING",
  "Tipping": "TIPPING",
  "Bladed": "BLADING",
  "Blading": "BLADING",
  "Completed Packs": "COMPLETE_PACKS",
  "Complete Packs": "COMPLETE_PACKS",
};

async function main() {
  console.log("Normalizing SKU material (process) values...\n");

  for (const [oldValue, newValue] of Object.entries(OLD_TO_NEW)) {
    const result = await prisma.sku.updateMany({
      where: { material: oldValue },
      data: { material: newValue },
    });
    if (result.count > 0) {
      console.log(`  "${oldValue}" → "${newValue}": ${result.count} SKUs updated`);
    }
  }

  // Report any remaining non-standard values
  const remaining = await prisma.sku.findMany({
    where: {
      material: { not: null },
      NOT: {
        material: { in: Object.values(OLD_TO_NEW) },
      },
    },
    select: { sku: true, material: true },
  });

  if (remaining.length > 0) {
    console.log(`\n⚠️  ${remaining.length} SKUs have unrecognized process values:`);
    for (const s of remaining) {
      console.log(`  ${s.sku}: "${s.material}"`);
    }
  } else {
    console.log("\n✅ All SKU process values are normalized.");
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
