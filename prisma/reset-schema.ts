import pg from 'pg';

const { Client } = pg;

async function resetSchema() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log('🔄 Resetting database schema...');

    // Drop and recreate the public schema
    await client.query('DROP SCHEMA IF EXISTS public CASCADE;');
    await client.query('CREATE SCHEMA public;');
    await client.query('GRANT ALL ON SCHEMA public TO beast_user;');
    await client.query('GRANT ALL ON SCHEMA public TO public;');

    console.log('✅ Schema reset complete');
  } catch (error) {
    console.error('❌ Error resetting schema:', error);
    throw error;
  } finally {
    await client.end();
  }
}

resetSchema();
