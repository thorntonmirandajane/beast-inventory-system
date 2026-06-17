# Beast Production Process — Working Spec

> **Status: DRAFT, v2 (answers folded in 2026-06-17).** Built from Michael's floor walkthrough + the
> app's existing BOM (`prisma/seed.ts`) and schema. Nothing is coded against this yet.
> **Action: red-pen anything wrong; confirm the reject model in §4.**

## 1. The core principle (this is what fixes the daily-count pain)

The plant runs on **perpetual inventory**: every unit's movement is captured *as it happens*, so the
system's running count is always trustworthy and **no full end-of-day count is needed**. Weekly
spot-checks catch drift.

Two ideas that must stay separate (mixing them is today's biggest bug):

| | **Movement** (what actually changes stock) | **Planning** (what to build / buy) |
|---|---|---|
| Scope | **One level at a time** — consumes only the immediate BOM children | **Recursive** — explodes the whole tree |
| Trigger | A worker's logged work, **after QC approval** | A forecast / order demand |
| Example | Approving "500 bladed" consumes 500 *tipped ferrules* + 1000 blades + 500 pins, adds 500 *bladed ferrules* | "We owe 9,000 COC packs" → explode to raw blades, studs, springs to purchase |
| Lives in | The inventory engine (this spec) | The build planner (Michael's sheet → future in-app forecast) |

**Inventory moves on exactly ONE event: QC approval of a worker's logged production.** Today it also
moves on work-order builds and on direct inventory-grid edits — those extra paths are what make stock
drift negative and force the hard count. They get consolidated into this one path.

## 2. The model is BOM-driven, not a fixed pipeline

There is **no hardcoded stage sequence.** Every SKU is `RAW`, `ASSEMBLY`, or `COMPLETED`, and its BOM
lists its immediate children. Producing an assembly consumes its children; that's the whole rule. This
is deliberately general because Beast will add product lines (turkey systems, bowfishing, etc.) that
**don't** follow the broadhead chain.

- The engine never hardcodes "tipping → blading." It reads: *output SKU `X` + qty `Q` → deduct each
  of `X`'s BOM children × `Q`, add `Q` of `X`.*
- "Process" names (TIPPING, BLADING, STUD_TESTING, COMPLETE_PACKS, …) are just **labels on the labor**
  for efficiency/time tracking. They don't define the recipe — the BOM does.

**The broadhead line, as an example chain** (each row = one worker reporting that output SKU):

| Process (label) | Output SKU example | Consumes (its BOM children) | Output type |
|---|---|---|---|
| TIPPING | `TIPPED-FERRULE` | `FERRULE` + `TIP-STEEL` | ASSEMBLY |
| BLADING | `2IN-BLADED-FERRULE` | tipped ferrule ×1 + `BLADE-2IN` ×2 + `BLADE-PIN` ×1 | ASSEMBLY |
| STUD_TESTING | `2IN-100G-BEAST` | bladed ferrule ×1 + springs + `BLADE-LOCK` + stud | ASSEMBLY |
| COMPLETE_PACKS | `3PACK-100g-2.0in` | broadhead ×(2 or 3) + band insert + backer + clamshell + sticker | COMPLETED |

Workers **log their completed output SKUs + counts at clock-out** (one batch per day).

## 3. Cut-on-Contact (COC) — handled automatically by the BOM

COC needs no special engine logic; it just has a different BOM chain. `COC-TI-FERRULE` is a **RAW**
SKU (it arrives pre-tipped with the cut blade from Tom / Iowa Brandon, received via PO). Its first
assembly is a **bladed ferrule** — so the COC bladed-ferrule BOM points straight at the raw COC
ferrule, **skipping the tipping step entirely**. Because movement is BOM-driven, this Just Works.

## 4. QC step + rejects (the movement gate) — CONFIRM THIS

End of day: worker logs output SKU + count → **QC (separate person)** inspects the trays, verifies the
count, and puts the good ones away on each SKU's rack. The approved/adjusted number drives **both** the
inventory move **and** the worker's efficiency.

- **Good (approved) count → produce.** Consume the output's BOM children × good-count, add good-count
  of the output SKU.
- **Rejected count → teardown in disposals.** The failed output is **not** added to stock. Instead it
  goes to a disposal/teardown step where the operator decides, **per component**, what to recover vs.
  scrap:
  - **Recover** → the component returns to stock at a chosen state (raw part, or an earlier
    sub-assembly like a tipped ferrule).
  - **Scrap** → the component is `DISPOSED`.

  *Real examples (Michael):* blading rejects where the tipped ferrules weren't fully screwed (adhesive
  set) → **recover the blades + blade pin**, **scrap the tipped ferrule**. Or good tips but bad blades
  → **recover back as a tipped ferrule + recover the blade pin**, **scrap the blades**.

  > **Proposed mechanic to confirm:** a reject deducts (DISPOSES) only the components marked *scrap*;
  > components marked *recover* return to stock at the state you pick. Net effect: scrap is removed,
  > recovered parts stay available, the bad assembly never counts as good stock. This reuses the
  > existing disposal **+ add-back** screen. **Is that the behavior you want?**

## 5. Inflows & outflows (the full ledger)

Every change is one row in the `InventoryLog` ledger:

- **PRODUCED** — QC-approved worker output (§2). Adds output, consumes children.
- **RECEIVED** — PO / receiving sign-off. Raw parts **and** outside-built items (incl. COC ferrules).
- **DISPOSED** — QC scrap (§4).
- **ADJUSTED** — recover-back from a teardown (§4), weekly spot-check fix (§6), or deliberate manual fix — always with a reason.
- **TRANSFERRED_OUT** — finished packs shipped (leaves the building; out of scope for reorder math).

## 6. Opening balance & weekly spot-checks (replacing the daily count)

- **Day zero:** the hard count (done 2026-06-17) seeds on-hand per SKU per state, once. From then on
  the system counts forward.
- **End of each day:** everything QC'd is put away/racked — nothing floats around, so the system count
  matches the racks.
- **Weekly:** spot-check a few SKUs, enter a physical count, the system shows variance and writes an
  `ADJUSTED` log with a reason. No more full daily count.

## 7. What changes in the app (reference — not built yet)

- One movement path: a single `applyProduction(timeEntryLine)` on QC approval, replacing the three
  current paths (`executeBuild`, inventory-grid `autoDeductRawMaterials`, time-entry-approval deduction).
- Movement consumes **immediate BOM children only** (never the recursive explosion).
- Guard: warn (don't silently allow) when a move would drive a SKU negative.
- The build planner's manual "EOD (on hand)" column becomes a live system number.

## 8. Roadmap (after the engine is solid — noted so we design toward it)

1. **Perpetual engine, good path** (this spec, §2 + §4 good count). Reproduction tests first.
2. **Reject / teardown disposals** with selective recover-vs-scrap (§4).
3. **Opening-count load + weekly spot-check** reconciliation (§6).
4. **In-app forecast / need-to-build** view (Michael's planner + David's 3-bucket demand).
5. **Auto-assign work to workers** from need-to-build × each worker's efficiency history, schedule, and
   per-process time — so the manager isn't guessing and everyone has clear daily assignments. *(Michael
   flagged this as a high-value future win; depends on 1 + 4.)*

---

## Resolved decisions (from the 2026-06-17 walkthrough)

- COC arrives as **`COC-TI-FERRULE` (RAW)**; first assembly is a bladed ferrule (no tipping).
- Model is **raw / assembly / completed, BOM-driven** — not a fixed 4-stage pipeline (other product
  lines coming).
- Rejects → **disposal with selective recover-or-scrap** (see §4 confirm).
- The in-app **BOM is trusted** as the source of truth.
- Workers log **at clock-out**, once per day.
- Everything is **put away/racked end of day after QC**.
