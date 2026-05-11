// One-time backfill: parse each SKU's code + name to populate the new
// grain and diameter columns. Idempotent — re-running it will only update
// rows whose parsed values changed (or were null).
//
// Run: npx tsx --env-file=.env scripts/backfill-grain-diameter.ts

import prisma from "../app/db.server";

function parseGrain(sku: string, name: string): number | null {
  const text = `${sku} ${name}`.toUpperCase();
  if (/(^|[^0-9])150\s*G/.test(text)) return 150;
  if (/(^|[^0-9])125\s*G/.test(text)) return 125;
  if (/(^|[^0-9])100\s*G/.test(text)) return 100;
  return null;
}

function parseDiameter(sku: string, name: string): number | null {
  const text = `${sku} ${name}`;
  // 2.3 / 23IN / 2.30 — check first so "2IN" inside "23IN" doesn't false-match
  if (/2\.3|23\s*IN|2\.30/i.test(text)) return 2.3;
  // 2.0 / 2IN with word boundaries (hyphens count as boundaries)
  if (/2\.0|\b2\s*IN\b/i.test(text)) return 2.0;
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
    const grain = parseGrain(s.sku, s.name);
    const diameter = parseDiameter(s.sku, s.name);

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
      `  ${s.sku.padEnd(40)} → grain=${grain ?? "-"} diameter=${diameter ?? "-"}`
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
