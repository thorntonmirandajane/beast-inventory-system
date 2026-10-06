-- Saved strategy comparisons. Only the inputs are stored; results are always
-- recomputed from live stock, so a saved scenario can't show stale numbers.
CREATE TABLE IF NOT EXISTS "fulfillment_scenarios" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "location" TEXT NOT NULL DEFAULT 'GALLATIN',
  "storeFilter" TEXT NOT NULL DEFAULT 'all',
  "priorityCustomers" TEXT NOT NULL DEFAULT '',
  "strategies" JSONB NOT NULL,
  "notes" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "fulfillment_scenarios_updatedAt_idx"
  ON "fulfillment_scenarios"("updatedAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fulfillment_scenarios_createdById_fkey') THEN
    ALTER TABLE "fulfillment_scenarios" ADD CONSTRAINT "fulfillment_scenarios_createdById_fkey"
      FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
