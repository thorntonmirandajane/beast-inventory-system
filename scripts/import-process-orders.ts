import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();

interface CSVRow {
  processOrder: number;
  skuCode: string;
}

async function importProcessOrders() {
  const csvPath = "/Users/mirandathornton/Downloads/TESTING ONLY BEAST PACKAGE CONTENTS- WORK ORDERS - ASSEMBLY_COMPLETED.csv";
  
  console.log("Reading CSV file...");
  const csvContent = fs.readFileSync(csvPath, "utf-8");
  const lines = csvContent.split("\n");
  
  // Skip header line (line 0) and empty lines
  const dataLines = lines.slice(1).filter(line => line.trim().length > 0);
  
  const updates: CSVRow[] = [];
  
  for (const line of dataLines) {
    // Split by comma, but be careful with quoted values
    const columns = line.split(",");
    
    // Column 0 is process order (empty string becomes NaN)
    const processOrderStr = columns[0]?.trim();
    if (!processOrderStr || processOrderStr === "") continue;
    
    const processOrder = parseInt(processOrderStr, 10);
    if (isNaN(processOrder)) continue;
    
    // Column 4 is SKU code
    const skuCode = columns[4]?.trim();
    if (!skuCode || skuCode === "") continue;
    
    updates.push({ processOrder, skuCode });
  }
  
  console.log(`Found ${updates.length} SKUs with process orders to update`);
  
  let successCount = 0;
  let notFoundCount = 0;
  let errorCount = 0;
  
  for (const { processOrder, skuCode } of updates) {
    try {
      // Find SKU by code
      const sku = await prisma.sku.findUnique({
        where: { sku: skuCode },
      });
      
      if (!sku) {
        console.log(`⚠️  SKU not found: ${skuCode} (process order ${processOrder})`);
        notFoundCount++;
        continue;
      }
      
      // Update process order
      await prisma.sku.update({
        where: { id: sku.id },
        data: { processOrder },
      });
      
      console.log(`✅ Updated ${skuCode} → Process Order ${processOrder}`);
      successCount++;
      
    } catch (error) {
      console.error(`❌ Error updating ${skuCode}:`, error);
      errorCount++;
    }
  }
  
  console.log("\n=== Import Summary ===");
  console.log(`✅ Successfully updated: ${successCount}`);
  console.log(`⚠️  SKUs not found: ${notFoundCount}`);
  console.log(`❌ Errors: ${errorCount}`);
  console.log(`📊 Total processed: ${updates.length}`);
}

importProcessOrders()
  .then(() => {
    console.log("\n✨ Process order import completed!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
