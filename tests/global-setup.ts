import dotenv from 'dotenv';
import { Client, Pool } from 'pg';
import { runMigrations } from '../src/db/migrate';

dotenv.config({ path: '.env.test', quiet: true });
dotenv.config({ quiet: true });

const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/transaction_ledger_test';

async function ensureDatabaseExists(connectionString: string): Promise<void> {
  const target = new URL(connectionString);
  const databaseName = decodeURIComponent(target.pathname.replace(/^\//, ''));

  if (!databaseName) {
    throw new Error('TEST_DATABASE_URL must include a database name');
  }

  target.pathname = '/postgres';

  const admin = new Client({ connectionString: target.toString() });
  await admin.connect();

  try {
    const existing = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [databaseName],
    );

    if ((existing.rowCount ?? 0) === 0) {
      await admin.query(
        `CREATE DATABASE ${admin.escapeIdentifier(databaseName)}`,
      );
    }
  } finally {
    await admin.end();
  }
}

export default async function setup(): Promise<void> {
  await ensureDatabaseExists(testDatabaseUrl);

  const pool = new Pool({ connectionString: testDatabaseUrl });

  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}
