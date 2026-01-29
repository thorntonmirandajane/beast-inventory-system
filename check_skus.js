const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const skus = await prisma.sku.findMany({
    where: { isActive: true },
    select: { sku: true, name: true, category: true, material: true, type: true },
    orderBy: { sku: 'asc' }
  });
  
  const processes = await prisma.processConfig.findMany({
    where: { isActive: true },
    select: { processName: true, displayName: true }
  });
  
  console.log('\n=== PROCESSES ===');
  processes.forEach(p => {
    console.log(p.displayName + ' (' + p.processName + ')');
  });
  
  console.log('\n=== SKUs (first 20) ===');
  skus.slice(0, 20).forEach(s => {
    console.log(s.sku + ' | Type: ' + s.type + ' | Category: ' + (s.category || 'null') + ' | Material: ' + (s.material || 'null'));
  });
  
  console.log('\nTotal SKUs: ' + skus.length);
}

main().finally(() => prisma.$disconnect());
