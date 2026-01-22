-- Add rejection photo field to worker time entries
ALTER TABLE "worker_time_entries" ADD COLUMN IF NOT EXISTS "rejectionPhoto" TEXT;

-- Note: PostgreSQL doesn't have CHECK constraints on existing columns by default
-- Inventory can now go negative by design (no changes needed)
