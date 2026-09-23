-- Per-account override: force an Admin/Manager onto the Worker Schedules grid
-- without changing their role.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "showOnSchedule" BOOLEAN NOT NULL DEFAULT false;

-- Kyler Oxnam is an Admin who still works scheduled shifts — keep him on the
-- schedule. (Name-based one-off; if the account is stored differently, an admin
-- can also toggle "Shows on schedule" on the Users page.)
UPDATE "users"
SET "showOnSchedule" = true
WHERE lower("firstName") = 'kyler' AND lower("lastName") = 'oxnam';
