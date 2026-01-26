-- CreateTable
CREATE TABLE "process_tutorials" (
    "id" TEXT NOT NULL,
    "processName" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "photoUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "process_tutorials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "process_tutorial_skus" (
    "id" TEXT NOT NULL,
    "processTutorialId" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,

    CONSTRAINT "process_tutorial_skus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "process_tutorials_processName_idx" ON "process_tutorials"("processName");

-- CreateIndex
CREATE INDEX "process_tutorial_skus_skuId_idx" ON "process_tutorial_skus"("skuId");

-- CreateIndex
CREATE UNIQUE INDEX "process_tutorial_skus_processTutorialId_skuId_key" ON "process_tutorial_skus"("processTutorialId", "skuId");

-- AddForeignKey
ALTER TABLE "process_tutorial_skus" ADD CONSTRAINT "process_tutorial_skus_processTutorialId_fkey" FOREIGN KEY ("processTutorialId") REFERENCES "process_tutorials"("id") ON DELETE CASCADE ON UPDATE CASCADE;
