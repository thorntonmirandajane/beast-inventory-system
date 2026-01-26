import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const completedSkus = await prisma.sku.findMany({
    where: {
      isActive: true,
      type: "COMPLETED",
    },
    include: {
      inventoryItems: {
        where: {
          quantity: { gt: 0 },
          state: "COMPLETED",
        },
      },
      bomComponents: {
        include: {
          componentSku: {
            include: {
              inventoryItems: {
                where: { quantity: { gt: 0 } },
              },
              bomComponents: {
                include: {
                  componentSku: {
                    include: {
                      inventoryItems: {
                        where: { quantity: { gt: 0 } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    orderBy: { sku: "asc" },
  });

  console.log(`Found ${completedSkus.length} COMPLETED SKUs`);
  console.log('\nFirst 3 SKUs:');
  completedSkus.slice(0, 3).forEach(sku => {
    console.log(`  ${sku.sku} - ${sku.name}`);
    console.log(`    BOM components: ${sku.bomComponents.length}`);
  });

  // Get forecasts
  const forecasts = await prisma.forecast.findMany();
  console.log(`\nFound ${forecasts.length} forecast records`);

  // Get process configs
  const processConfigs = await prisma.processConfig.findMany({
    where: { isActive: true },
  });
  console.log(`Found ${processConfigs.length} process configs`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
