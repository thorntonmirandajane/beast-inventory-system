# Daily Assignments — Spec (branch: feature/daily-assignments)

> Status: building on a branch for review **before** deploying to main.

## Purpose
An **end-of-day** tool: the manager generates **tomorrow's** suggested assignments so
workers walk in knowing exactly what to build — no downtime, no manager hand-assigning.

## Decisions (agreed)
- **Any worker / any task** for now (efficiency-weighting later when there's history).
- **SKU-specific** suggestions (process + SKU + qty), not just process-level.
- **One day at a time** (default tomorrow), re-run each evening.
- **Respect stage order + buildability**: prioritize upstream (tipping → blading →
  stud-test → packing); only suggest a task whose inputs exist. Blocked work is shown
  separately so the bottleneck is visible.
- **Editable**: admin/Carson can change the worker (dropdown) or qty on any row before
  committing. Commit writes the existing `WorkerTask`s (due that date, DAILY) that
  workers already pick up in Submit Task.

## The pending-QC consideration (critical)
A worker's submitted production **does not move inventory until QC approves it**. Planning
off *approved* stock alone would re-assign work already done today. So the planner runs
against **projected inventory**:

```
projected stock = approved on-hand
                + outputs of submitted-but-not-yet-approved lines
                − components those lines will consume (per BOM)
```

i.e. apply every PENDING time-entry line through the same single-level BOM engine
(planProduction) to a projected copy of inventory, then plan against that.

## Partial builds + priority (added)
- **No all-or-nothing blocking.** Each task builds as many units as the tightest input
  allows *right now* (`min over inputs of floor(stock / qtyPer)`); the rest is shown as
  blocked-by-shortage. So 4,048 ferrules against a 10k pack need → tip 4,048 now, 5,952
  blocked — not the whole job blocked.
- **Oldest backorder first.** Each completed SKU inherits the oldest `orderCreatedAt` of
  its unfulfilled Shopify lines; sub-assemblies inherit the oldest among the products that
  need them. The queue is sorted oldest-first, then most-upstream, and constrained inputs
  are allocated greedily in that order — so the scarce ferrules flow to the most overdue
  product line first.

## Algorithm
1. **Projected inventory** — approved InventoryItem totals, then apply all PENDING
   time-entry-line production (add outputs, consume immediate BOM children).
2. **Need by stage** — from the forecast's need-to-build per completed SKU, explode to
   each sub-assembly stage's shortfall using *projected* inventory → list of
   `(process, sku, units, hours)`; flag **buildable** (immediate inputs in projected
   stock) vs **blocked** (needs an upstream stage first).
3. **Prioritize** — buildable first; upstream stage before downstream; bigger/closer-due
   need first.
4. **Assign (any worker)** — fill each scheduled worker's hours (from `WorkerSchedule`
   for the date) from the top of the queue; split a large task across workers as needed.
5. **Review screen** — editable table (Worker dropdown | Process | SKU | Qty | ~Hours),
   per-worker hours-used vs scheduled, a "Blocked / can't start yet" section, and
   **Create Assignments**.

## Later (reuse this need-vs-capacity engine)
- **Catch-up tracker** — remaining build hours ÷ daily capacity = days to caught up.
- **Executive brief** — yesterday built vs planned; today's plan and where it leaves us.
- **Inventory-risk alerts** — where the plan drives a raw material negative / run-out
  (with reorder lead times).
