-- Fulfillment "game plans": rules for partially shipping a backlog, plus one
-- recorded action per order so an order can't be picked twice unnoticed.
CREATE TABLE IF NOT EXISTS "fulfillment_plans" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "location" TEXT NOT NULL DEFAULT 'GALLATIN',
  "storeFilter" TEXT NOT NULL DEFAULT 'all',
  "noteTemplate" TEXT NOT NULL DEFAULT '{plan}: ship {items} from {location}',
  "rules" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "fulfillment_plans_status_updatedAt_idx"
  ON "fulfillment_plans"("status","updatedAt");

CREATE TABLE IF NOT EXISTS "fulfillment_plan_actions" (
  "id" TEXT PRIMARY KEY,
  "planId" TEXT NOT NULL,
  "store" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "orderName" TEXT NOT NULL,
  "location" TEXT NOT NULL,
  "lines" JSONB NOT NULL,
  "units" INTEGER NOT NULL DEFAULT 0,
  "note" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PLANNED',
  "exportedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "fulfillment_plan_actions_planId_store_orderId_key"
  ON "fulfillment_plan_actions"("planId","store","orderId");
CREATE INDEX IF NOT EXISTS "fulfillment_plan_actions_orderId_idx"
  ON "fulfillment_plan_actions"("orderId");
CREATE INDEX IF NOT EXISTS "fulfillment_plan_actions_status_idx"
  ON "fulfillment_plan_actions"("status");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fulfillment_plans_createdById_fkey') THEN
    ALTER TABLE "fulfillment_plans" ADD CONSTRAINT "fulfillment_plans_createdById_fkey"
      FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fulfillment_plan_actions_planId_fkey') THEN
    ALTER TABLE "fulfillment_plan_actions" ADD CONSTRAINT "fulfillment_plan_actions_planId_fkey"
      FOREIGN KEY ("planId") REFERENCES "fulfillment_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
