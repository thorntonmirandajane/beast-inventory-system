#!/bin/bash
set -e

echo "Fixing failed migration state..."

# Mark the failed migration as rolled back in the database
psql $DATABASE_URL <<EOF
-- Mark the failed migration as rolled back
UPDATE "_prisma_migrations"
SET finished_at = started_at,
    migration_name = '20240126000000_remove_manager_role',
    logs = 'Manually resolved - moved to 20240128000000_add_notifications'
WHERE migration_name = '20240126000000_remove_manager_role'
AND finished_at IS NULL;

-- If it doesn't exist at all, insert it as completed
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
EOF

echo "Migration state fixed. Running prisma migrate deploy..."
npx prisma migrate deploy
