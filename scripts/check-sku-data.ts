import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function check() {
  const samples = await prisma.sku.findMany({
    where: { isActive: true },
    select: { sku: true, material: true, category: true },
    take: 20,
  });
  
  console.log("Sample SKU data (sku, material, category):");
  samples.forEach(s => {
    console.log(`  ${s.sku}: material="${s.material}", category="${s.category}"`);
  });
  
  const uniqueMaterials = await prisma.sku.findMany({
    where: { material: { not: null } },
    select: { material: true },
    distinct: ["material"],
  });
  console.log("\nUnique materials:", uniqueMaterials.map(m => m.material));
  
  const uniqueCategories = await prisma.sku.findMany({
    where: { category: { not: null } },
    select: { category: true },
    distinct: ["category"],
  });
  console.log("Unique categories:", uniqueCategories.map(c => c.category));
}

check().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
