import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const skuCounts = await prisma.sku.groupBy({
    by: ['type'],
    where: { isActive: true },
    _count: true,
  });

  console.log('SKU counts by type:');
  skuCounts.forEach(group => {
    console.log(`  ${group.type}: ${group._count}`);
  });

  const completedSkus = await prisma.sku.findMany({
    where: {
      type: 'COMPLETED',
      isActive: true,
    },
    select: {
      id: true,
      sku: true,
      name: true,
      type: true,
    },
    take: 10,
  });

  console.log('\nCompleted SKUs:');
  if (completedSkus.length === 0) {
    console.log('  No COMPLETED SKUs found');
  } else {
    completedSkus.forEach(sku => {
      console.log(`  ${sku.sku} - ${sku.name}`);
    });
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
