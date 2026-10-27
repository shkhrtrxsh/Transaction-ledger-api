import { afterAll, beforeEach } from 'vitest';
import { pool } from '../src/db/pool';

async function dropTestTriggers(): Promise<void> {
  await pool.query(
    'DROP TRIGGER IF EXISTS test_fail_ledger_insert ON transactions',
  );
  await pool.query('DROP FUNCTION IF EXISTS test_fail_ledger_insert() CASCADE');
  await pool.query(
    'DROP TRIGGER IF EXISTS test_fail_transfer_credit ON transactions',
  );
  await pool.query('DROP FUNCTION IF EXISTS test_fail_transfer_credit() CASCADE');
}

beforeEach(async () => {
  await dropTestTriggers();
  await pool.query(
    'TRUNCATE TABLE transactions, transfers, accounts RESTART IDENTITY CASCADE',
  );
});

afterAll(async () => {
  await dropTestTriggers();
  await pool.end();
});
