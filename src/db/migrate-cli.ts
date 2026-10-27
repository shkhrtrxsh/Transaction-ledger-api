import { pool } from './pool';
import { runMigrations } from './migrate';

async function main(): Promise<void> {
  const applied = await runMigrations(pool);

  if (applied.length === 0) {
    console.log('No pending migrations.');
  } else {
    console.log(`Applied migrations: ${applied.join(', ')}`);
  }
}

main()
  .catch((error) => {
    console.error('Migration failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
