import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function resetSchema() {
  try {
    console.log('🔄 Resetting database schema...');

    // Drop and recreate the public schema
    await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE;');
    await prisma.$executeRawUnsafe('CREATE SCHEMA public;');
    await prisma.$executeRawUnsafe('GRANT ALL ON SCHEMA public TO beast_user;');
    await prisma.$executeRawUnsafe('GRANT ALL ON SCHEMA public TO public;');

    console.log('✅ Schema reset complete');
  } catch (error) {
    console.error('❌ Error resetting schema:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

resetSchema();
