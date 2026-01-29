import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function checkProcessOrders() {
  const skusWithOrders = await prisma.sku.findMany({
    where: {
      processOrder: { not: null }
    },
    select: {
      sku: true,
      name: true,
      processOrder: true
    },
    orderBy: { processOrder: 'asc' },
    take: 10
  });

  console.log(`Found ${skusWithOrders.length} SKUs with process orders (showing first 10):`);
  skusWithOrders.forEach(sku => {
    console.log(`  Order ${sku.processOrder}: ${sku.sku}`);
  });

  const totalWithOrders = await prisma.sku.count({
    where: { processOrder: { not: null } }
  });
  
  console.log(`\nTotal SKUs with process orders: ${totalWithOrders}`);
}

checkProcessOrders()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
