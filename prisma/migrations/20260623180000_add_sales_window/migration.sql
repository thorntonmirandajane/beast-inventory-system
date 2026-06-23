-- Editable "Sales Date" window (YTD) for the projection forecaster.
ALTER TABLE "forecast_scenarios" ADD COLUMN IF NOT EXISTS "salesStart" TIMESTAMP(3);
ALTER TABLE "forecast_scenarios" ADD COLUMN IF NOT EXISTS "salesEnd" TIMESTAMP(3);
