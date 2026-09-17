-- Weekly grid becomes the single source of truth (date-specific). Deactivate
-- recurring patterns so 'blank = day off' holds across all schedule readers
-- (auto-assignment, late-clock-in, capacity, etc. all filter isActive). The rows
-- are kept (not deleted) so the grid can pre-fill new weeks from the pattern.
UPDATE "worker_schedules" SET "isActive" = false WHERE "scheduleType" = 'RECURRING';
