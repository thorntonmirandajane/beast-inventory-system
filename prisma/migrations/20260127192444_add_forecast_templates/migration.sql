-- CreateTable
CREATE TABLE "forecast_templates" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forecast_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forecast_template_items" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "currentInGallatin" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "forecast_template_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "forecast_templates_createdById_idx" ON "forecast_templates"("createdById");

-- CreateIndex
CREATE INDEX "forecast_template_items_templateId_idx" ON "forecast_template_items"("templateId");

-- CreateIndex
CREATE INDEX "forecast_template_items_skuId_idx" ON "forecast_template_items"("skuId");

-- AddForeignKey
ALTER TABLE "forecast_templates" ADD CONSTRAINT "forecast_templates_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forecast_template_items" ADD CONSTRAINT "forecast_template_items_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "forecast_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forecast_template_items" ADD CONSTRAINT "forecast_template_items_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
