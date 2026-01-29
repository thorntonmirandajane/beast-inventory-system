import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function check() {
  const configs = await prisma.processConfig.findMany({
    select: { processName: true, displayName: true },
  });
  
  console.log("Process Configs (processName, displayName):");
  configs.forEach(c => {
    console.log(`  ${c.processName}: "${c.displayName}"`);
  });
}

check().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
