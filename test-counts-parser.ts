// Pure (no-DB) test for the opening-count parser. Run: node test-counts-parser.ts
import { parseOpeningCountRows } from "./app/utils/counts.ts";

let failures = 0;
function check(label: string, cond: boolean) {
  if (!cond) failures++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
}

// Paste straight from a sheet: header, section labels, tabs, thousands-commas, blanks.
const input = [
  "SKU,Quantity", // header -> skipped (no number)
  "Standard (Aluminum)", // section label -> skipped (no number)
  "",
  "BLADE-2IN, 33460",
  "3PACK-100g-2.0in, 3,489", // thousands comma -> 3489
  "TIPPED-FERRULE\t1920", // tab separated
  "BEAST-AID,-5", // negative -> error
  "BAD-ROW, abc", // no number -> skipped silently (like a section label)
].join("\n");

const { rows, errors } = parseOpeningCountRows(input);
const bySku = Object.fromEntries(rows.map((r) => [r.sku, r.qty]));

console.log("Parser:");
check("skips header + section + blank (3 valid rows)", rows.length === 3);
check("BLADE-2IN = 33460", bySku["BLADE-2IN"] === 33460);
check("thousands comma 3,489 -> 3489", bySku["3PACK-100g-2.0in"] === 3489);
check("tab-separated TIPPED-FERRULE = 1920", bySku["TIPPED-FERRULE"] === 1920);
check("negative quantity is an error", errors.some((e) => e.includes("negative")));
check("row with no number is skipped, not errored", !("BAD-ROW" in bySku));
check("one error total (the negative)", errors.length === 1);

console.log(`\n${failures === 0 ? "✅ ALL PASSED" : `❌ ${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
