/*
  Warnings:

  - You are about to drop the column `processOrder` on the `process_configs` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "process_configs" DROP COLUMN "processOrder";

-- AlterTable
ALTER TABLE "skus" ADD COLUMN     "processOrder" INTEGER;
