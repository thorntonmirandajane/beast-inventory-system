-- Idempotency key for a worker's "Submit Tasks" batch. The submission id is
-- generated once per staged batch on the client and resent on a retry, so this
-- index is what stops a double-tap writing the same day's work twice — the
-- application-level check alone loses the race when both taps land together.
CREATE UNIQUE INDEX IF NOT EXISTS "audit_logs_submit_task_batch_key"
  ON "audit_logs"("resourceId")
  WHERE "action" = 'SUBMIT_TASK_BATCH';
