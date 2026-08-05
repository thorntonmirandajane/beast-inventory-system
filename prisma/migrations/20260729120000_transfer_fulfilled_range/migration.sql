-- Record which fulfilled-orders date range a transfer covers, to avoid overlap.
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "fulfilledFrom" TIMESTAMP(3);
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "fulfilledTo" TIMESTAMP(3);
