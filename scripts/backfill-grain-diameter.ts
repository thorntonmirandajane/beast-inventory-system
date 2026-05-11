// One-time backfill: parse each SKU's code (not the name — names can be
// stale or mismatched) to populate the new grain and diameter columns.
// Idempotent — re-running it only writes rows whose parsed values differ.
//
// Run: npx tsx --env-file=.env scripts/backfill-grain-diameter.ts

import prisma from "../app/db.server";

export function parseGrain(sku: string): number | null {
  const s = sku.toUpperCase();
  if (/(^|[^0-9])150G/.test(s)) return 150;
  if (/(^|[^0-9])125G/.test(s)) return 125;
  if (/(^|[^0-9])100G/.test(s)) return 100;
  return null;
}

export function parseDiameter(sku: string): number | null {
  const s = sku.toUpperCase();
  // Check 2.3 / 23IN first so the "2" inside them doesn't false-match below
  if (/2\.3|(^|[^0-9])23IN/.test(s)) return 2.3;
  // 2.0 / 2IN with word boundaries — won't match inside 23IN or 2.0IN
  if (/2\.0|(^|[^0-9])2IN(?![0-9])/.test(s)) return 2.0;
  return null;
}

async function main() {
  const skus = await prisma.sku.findMany({
    select: { id: true, sku: true, name: true, grain: true, diameter: true },
    orderBy: { sku: "asc" },
  });

  let updated = 0;
  let unchanged = 0;
  let null_count = 0;

  for (const s of skus) {
    const grain = parseGrain(s.sku);
    const diameter = parseDiameter(s.sku);

    if (grain === s.grain && diameter === s.diameter) {
      unchanged++;
      if (grain === null && diameter === null) null_count++;
      continue;
    }

    await prisma.sku.update({
      where: { id: s.id },
      data: { grain, diameter },
    });
    updated++;
    console.log(
      `  ${s.sku.padEnd(40)} grain ${String(s.grain ?? "-").padStart(3)} → ${String(grain ?? "-").padStart(3)}   diameter ${String(s.diameter ?? "-").padStart(3)} → ${String(diameter ?? "-")}`
    );
  }

  console.log(
    `\nDone. Updated ${updated}, unchanged ${unchanged} (of which ${null_count} have neither grain nor diameter — those will show "-" in the UI).`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
