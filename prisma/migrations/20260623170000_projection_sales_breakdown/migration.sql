-- Break projection demand into fulfilled / unfulfilled / programmed components.
ALTER TABLE "projection_sales" ADD COLUMN IF NOT EXISTS "ytdFulfilled" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "projection_sales" ADD COLUMN IF NOT EXISTS "ytdUnfulfilled" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "projection_sales" ADD COLUMN IF NOT EXISTS "programmedQty" INTEGER NOT NULL DEFAULT 0;
