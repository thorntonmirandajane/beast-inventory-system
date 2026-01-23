import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const skus = await prisma.sku.findMany({
  take: 20,
  select: {
    sku: true,
    type: true,
    material: true,
    category: true,
    name: true
  },
  orderBy: { sku: 'asc' }
});

console.log('SKU Data:');
console.log(JSON.stringify(skus, null, 2));

await prisma.$disconnect();
