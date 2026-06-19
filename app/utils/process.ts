// Shared SKU ↔ process matching, so every screen agrees on "which process
// builds this SKU". A SKU's process is stored in its `material` field and
// matched against a ProcessConfig's displayName (the time clock / capacity page,
// worker submit-task, and forecasting all use this).
//
//   material "Tipped" / "Tipping" / "Stud Testing (2.3)"  ->  process displayName

export function matchesProcess(material: string | null, processDisplayName: string): boolean {
  if (!material) return false;
  const m = material.toLowerCase().replace(/\s+/g, " ").trim();
  const p = processDisplayName.toLowerCase().replace(/\s+/g, " ").trim();
  if (m === p) return true;
  if (m.replace(/ed$/, "ing") === p) return true; // "tipped" -> "tipping", "bladed" -> "blading"
  if (m.replace("completed", "complete") === p) return true; // "completed packs" -> "complete packs"
  return false;
}

/** Resolve a SKU's `material` to the ProcessConfig that builds it, if any. */
export function resolveProcessConfig<T extends { displayName: string }>(
  material: string | null,
  configs: T[]
): T | undefined {
  if (!material) return undefined;
  return configs.find((c) => matchesProcess(material, c.displayName));
}
