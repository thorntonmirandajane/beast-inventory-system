-- Track whether a time-entry line's inventory movement has already been applied,
-- so re-approving a re-opened entry doesn't double-produce/consume.
ALTER TABLE "time_entry_lines" ADD COLUMN IF NOT EXISTS "inventoryApplied" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: lines already in an APPROVED entry have already moved inventory.
UPDATE "time_entry_lines"
SET "inventoryApplied" = true
WHERE "timeEntryId" IN (SELECT "id" FROM "worker_time_entries" WHERE "status" = 'APPROVED');
