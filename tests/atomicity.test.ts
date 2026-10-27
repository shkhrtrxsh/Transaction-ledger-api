import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import {
  api,
  createAccount,
  createTransaction,
  createTransfer,
  getBalance,
  getHistory,
  uniqueReference,
} from './helpers';

async function dropLedgerFailureTrigger(): Promise<void> {
  await pool.query(
    'DROP TRIGGER IF EXISTS test_fail_ledger_insert ON transactions',
  );
  await pool.query('DROP FUNCTION IF EXISTS test_fail_ledger_insert()');
}

async function dropTransferFailureTrigger(): Promise<void> {
  await pool.query(
    'DROP TRIGGER IF EXISTS test_fail_transfer_credit ON transactions',
  );
  await pool.query('DROP FUNCTION IF EXISTS test_fail_transfer_credit()');
}

describe('database atomicity and immutability', () => {
  it('rolls back a balance update when the ledger insert fails', async () => {
    const account = await createAccount();

    await pool.query(`
      CREATE FUNCTION test_fail_ledger_insert()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.reference_id = 'forced-ledger-failure' THEN
          RAISE EXCEPTION 'forced ledger insert failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await pool.query(`
      CREATE TRIGGER test_fail_ledger_insert
      BEFORE INSERT ON transactions
      FOR EACH ROW
      EXECUTE FUNCTION test_fail_ledger_insert()
    `);

    try {
      const response = await api()
        .post(`/accounts/${account.id}/transactions`)
        .send({
          type: 'credit',
          amount: '25.00',
          reference_id: 'forced-ledger-failure',
        });

      expect(response.status).toBe(500);
      expect(response.body.error.code).toBe('INTERNAL_ERROR');
      expect(await getBalance(account.id)).toBe('0.00');
      expect((await getHistory(account.id)).pagination.total_records).toBe(0);
    } finally {
      await dropLedgerFailureTrigger();
    }
  });

  it('rolls back the transfer, both entries, and both balances when the destination ledger insert fails', async () => {
    const source = await createAccount('Source');
    const destination = await createAccount('Destination');
    await createTransaction(source.id, { type: 'credit', amount: '100.00' });

    await pool.query(`
      CREATE FUNCTION test_fail_transfer_credit()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.transfer_id IS NOT NULL AND NEW.type = 'credit' THEN
          RAISE EXCEPTION 'forced destination ledger insert failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await pool.query(`
      CREATE TRIGGER test_fail_transfer_credit
      BEFORE INSERT ON transactions
      FOR EACH ROW
      EXECUTE FUNCTION test_fail_transfer_credit()
    `);

    try {
      const response = await api().post('/transfers').send({
        source_account_id: source.id,
        destination_account_id: destination.id,
        amount: '30.00',
        reference_id: uniqueReference('forced-transfer-failure'),
      });

      expect(response.status).toBe(500);
      expect(response.body.error.code).toBe('INTERNAL_ERROR');
      expect(await getBalance(source.id)).toBe('100.00');
      expect(await getBalance(destination.id)).toBe('0.00');

      const transfers = await pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM transfers',
      );
      expect(transfers.rows[0]?.count).toBe('0');

      const entries = await pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM transactions WHERE transfer_id IS NOT NULL',
      );
      expect(entries.rows[0]?.count).toBe('0');
      expect((await getHistory(source.id)).pagination.total_records).toBe(1);
      expect((await getHistory(destination.id)).pagination.total_records).toBe(
        0,
      );
    } finally {
      await dropTransferFailureTrigger();
    }
  });

  it('rejects updates and deletes of ordinary ledger entries', async () => {
    const account = await createAccount();
    const result = await createTransaction(account.id, {
      type: 'credit',
      amount: '10.00',
    });

    await expect(
      pool.query('UPDATE transactions SET amount = 99.00 WHERE id = $1', [
        result.transaction.id,
      ]),
    ).rejects.toThrow(/immutable/);

    await expect(
      pool.query('DELETE FROM transactions WHERE id = $1', [
        result.transaction.id,
      ]),
    ).rejects.toThrow(/immutable/);
  });

  it('rejects updates and deletes of transfer records and their entries', async () => {
    const source = await createAccount('Source');
    const destination = await createAccount('Destination');
    await createTransaction(source.id, { type: 'credit', amount: '100.00' });
    const transfer = await createTransfer({
      source_account_id: source.id,
      destination_account_id: destination.id,
      amount: '10.00',
    });

    await expect(
      pool.query('UPDATE transfers SET amount = 99.00 WHERE id = $1', [
        transfer.transfer_id,
      ]),
    ).rejects.toThrow(/immutable/);

    await expect(
      pool.query('DELETE FROM transfers WHERE id = $1', [transfer.transfer_id]),
    ).rejects.toThrow(/immutable/);

    await expect(
      pool.query('DELETE FROM transactions WHERE transfer_id = $1', [
        transfer.transfer_id,
      ]),
    ).rejects.toThrow(/immutable/);

    await expect(
      pool.query('UPDATE transactions SET amount = 99.00 WHERE id = $1', [
        transfer.source_transaction_id,
      ]),
    ).rejects.toThrow(/immutable/);
  });

  it('prevents duplicate debit or credit entries for the same transfer', async () => {
    const source = await createAccount('Source');
    const destination = await createAccount('Destination');
    const extra = await createAccount('Extra');
    await createTransaction(source.id, { type: 'credit', amount: '100.00' });
    const transfer = await createTransfer({
      source_account_id: source.id,
      destination_account_id: destination.id,
      amount: '10.00',
    });

    await expect(
      pool.query(
        `
          INSERT INTO transactions (
            account_id,
            type,
            amount,
            reference_id,
            transfer_id
          )
          VALUES ($1, 'credit', 1.00, 'duplicate-transfer-credit', $2)
        `,
        [extra.id, transfer.transfer_id],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('prevents deleting accounts referenced by ledger entries or transfers', async () => {
    const source = await createAccount('Source');
    const destination = await createAccount('Destination');
    await createTransaction(source.id, { type: 'credit', amount: '100.00' });
    await createTransfer({
      source_account_id: source.id,
      destination_account_id: destination.id,
      amount: '10.00',
    });

    await expect(
      pool.query('DELETE FROM accounts WHERE id = $1', [source.id]),
    ).rejects.toMatchObject({ code: '23503' });

    await expect(
      pool.query('DELETE FROM accounts WHERE id = $1', [destination.id]),
    ).rejects.toMatchObject({ code: '23503' });
  });
});
