// Pure (no-DB) parser for the opening-count / spot-check uploader.
// Accepts pasted rows or CSV of "SKU, quantity" — one per line. State is NOT
// in the file; it's inferred later from each SKU's type.
//
// Tolerant by design so you can paste straight from the build-planner tabs:
//   - comma OR tab separated
//   - thousands separators in the quantity ("2,878" -> 2878)
//   - blank lines and section-header rows (a label with no number) are skipped
//   - a leading "SKU,Quantity" header row is skipped

export interface ParsedCountRow {
  sku: string;
  qty: number;
  line: number;
}

export interface CountParseResult {
  rows: ParsedCountRow[];
  errors: string[];
}

export function parseOpeningCountRows(text: string): CountParseResult {
  const rows: ParsedCountRow[] = [];
  const errors: string[] = [];

  text.split(/\r?\n/).forEach((raw, idx) => {
    const lineNo = idx + 1;
    const line = raw.trim();
    if (!line) return;

    const cells = (line.includes("\t") ? line.split("\t") : line.split(",")).map((c) =>
      c.trim()
    );
    const sku = cells[0];
    if (!sku) return;

    // Everything after the SKU, stripped to a number. Empty => a label/section
    // header row (e.g. "Standard (Aluminum)") or a header — skip it silently.
    const qtyRaw = cells.slice(1).join("").replace(/[^0-9.\-]/g, "");
    if (qtyRaw === "") return;

    const qty = Math.round(Number(qtyRaw));
    if (!Number.isFinite(qty)) {
      errors.push(`Line ${lineNo}: invalid quantity for "${sku}"`);
      return;
    }
    if (qty < 0) {
      errors.push(`Line ${lineNo}: negative quantity (${qty}) for "${sku}"`);
      return;
    }

    rows.push({ sku, qty, line: lineNo });
  });

  return { rows, errors };
}
