import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function fixFailedMigration() {
  try {
    console.log('Checking for failed migrations...');

    // Mark the failed migration as completed
    await prisma.$executeRawUnsafe(`
      UPDATE "_prisma_migrations"
      SET finished_at = started_at,
          logs = 'Manually resolved - moved to 20240128000000_add_notifications'
      WHERE migration_name = '20240126000000_remove_manager_role'
      AND finished_at IS NULL;
    `);

    // Insert if it doesn't exist
    await prisma.$executeRawUnsafe(`
      INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
      SELECT
        gen_random_uuid()::text,
        'placeholder',
        NOW(),
        '20240126000000_remove_manager_role',
        'Placeholder migration - logic moved to 20240128000000_add_notifications',
        NULL,
        NOW(),
        0
      WHERE NOT EXISTS (
        SELECT 1 FROM "_prisma_migrations"
        WHERE migration_name = '20240126000000_remove_manager_role'
      );
    `);

    console.log('Failed migration marked as resolved.');
  } catch (error) {
    console.log('Note: Could not fix migration (this is OK if migrations table does not exist yet)');
    console.log(error);
  } finally {
    await prisma.$disconnect();
  }
}

fixFailedMigration();
