import dotenv from 'dotenv';
import { defineConfig } from 'vitest/config';

dotenv.config({ path: '.env.test', quiet: true });
dotenv.config({ quiet: true });

const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/transaction_ledger_test';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/setup.ts'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: testDatabaseUrl,
      TEST_DATABASE_URL: testDatabaseUrl,
    },
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 20_000,
    pool: 'forks',
  },
});
