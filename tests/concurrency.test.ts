import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import {
  api,
  createAccount,
  createTransaction,
  getBalance,
  getHistory,
  uniqueReference,
} from './helpers';

async function transferCount(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM transfers',
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function transferEntryCount(transferId?: string): Promise<number> {
  const result = transferId
    ? await pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM transactions WHERE transfer_id = $1',
        [transferId],
      )
    : await pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM transactions WHERE transfer_id IS NOT NULL',
      );

  return Number(result.rows[0]?.count ?? '0');
}

describe('concurrency and serialization', () => {
  it('prevents concurrent debits from overdrawing an account', async () => {
    const account = await createAccount();
    await createTransaction(account.id, {
      type: 'credit',
      amount: '100.00',
    });

    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        api()
          .post(`/accounts/${account.id}/transactions`)
          .send({
            type: 'debit',
            amount: '10.00',
            reference_id: uniqueReference(`concurrent-debit-${index}`),
          }),
      ),
    );

    const successes = responses.filter((response) => response.status === 201);
    const failures = responses.filter((response) => response.status === 409);

    expect(successes).toHaveLength(10);
    expect(failures).toHaveLength(2);
    expect(
      failures.every(
        (response) => response.body.error.code === 'INSUFFICIENT_FUNDS',
      ),
    ).toBe(true);
    expect(await getBalance(account.id)).toBe('0.00');

    const history = await getHistory(account.id);
    expect(history.pagination.total_records).toBe(11);
  });

  it('creates exactly one transaction for concurrent duplicate submissions', async () => {
    const account = await createAccount();
    const referenceId = uniqueReference('concurrent-duplicate');

    const responses = await Promise.all(
      Array.from({ length: 9 }, () =>
        api()
          .post(`/accounts/${account.id}/transactions`)
          .send({
            type: 'credit',
            amount: '5.00',
            reference_id: referenceId,
          }),
      ),
    );

    expect(responses.filter((response) => response.status === 201)).toHaveLength(
      1,
    );
    expect(responses.filter((response) => response.status === 409)).toHaveLength(
      8,
    );
    expect(
      responses
        .filter((response) => response.status === 409)
        .every(
          (response) => response.body.error.code === 'DUPLICATE_REFERENCE',
        ),
    ).toBe(true);
    expect(await getBalance(account.id)).toBe('5.00');

    const history = await getHistory(account.id);
    expect(history.pagination.total_records).toBe(1);
  });

  it('prevents concurrent transfers from overspending one source account', async () => {
    const source = await createAccount('Source');
    const destination = await createAccount('Destination');
    await createTransaction(source.id, {
      type: 'credit',
      amount: '100.00',
    });

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        api()
          .post('/transfers')
          .send({
            source_account_id: source.id,
            destination_account_id: destination.id,
            amount: '20.00',
            reference_id: uniqueReference(`concurrent-transfer-${index}`),
          }),
      ),
    );

    expect(responses.filter((response) => response.status === 201)).toHaveLength(
      5,
    );
    expect(responses.filter((response) => response.status === 409)).toHaveLength(
      5,
    );
    expect(
      responses
        .filter((response) => response.status === 409)
        .every(
          (response) => response.body.error.code === 'INSUFFICIENT_FUNDS',
        ),
    ).toBe(true);

    expect(await getBalance(source.id)).toBe('0.00');
    expect(await getBalance(destination.id)).toBe('100.00');
    expect((await getHistory(source.id)).pagination.total_records).toBe(6);
    expect((await getHistory(destination.id)).pagination.total_records).toBe(5);
    expect(await transferCount()).toBe(5);
    expect(await transferEntryCount()).toBe(10);
  });

  it('completes simultaneous opposite-direction transfers without deadlock', async () => {
    const first = await createAccount('First');
    const second = await createAccount('Second');
    await createTransaction(first.id, { type: 'credit', amount: '100.00' });
    await createTransaction(second.id, { type: 'credit', amount: '100.00' });

    const [firstToSecond, secondToFirst] = await Promise.all([
      api().post('/transfers').send({
        source_account_id: first.id,
        destination_account_id: second.id,
        amount: '50.00',
        reference_id: uniqueReference('first-to-second'),
      }),
      api().post('/transfers').send({
        source_account_id: second.id,
        destination_account_id: first.id,
        amount: '50.00',
        reference_id: uniqueReference('second-to-first'),
      }),
    ]);

    expect(firstToSecond.status).toBe(201);
    expect(secondToFirst.status).toBe(201);
    expect(firstToSecond.body.transfer_id).not.toBe(
      secondToFirst.body.transfer_id,
    );

    expect(await getBalance(first.id)).toBe('100.00');
    expect(await getBalance(second.id)).toBe('100.00');
    // Each account has its funding credit, its outgoing debit, and the
    // incoming credit from the opposite transfer.
    expect((await getHistory(first.id)).pagination.total_records).toBe(3);
    expect((await getHistory(second.id)).pagination.total_records).toBe(3);
    expect(await transferCount()).toBe(2);
    expect(await transferEntryCount()).toBe(4);
  });

  it('creates exactly one transfer and two ledger entries for concurrent duplicates', async () => {
    const source = await createAccount('Source');
    const destination = await createAccount('Destination');
    await createTransaction(source.id, { type: 'credit', amount: '100.00' });
    const referenceId = uniqueReference('concurrent-transfer-duplicate');

    const responses = await Promise.all(
      Array.from({ length: 9 }, () =>
        api().post('/transfers').send({
          source_account_id: source.id,
          destination_account_id: destination.id,
          amount: '10.00',
          reference_id: referenceId,
        }),
      ),
    );

    const successes = responses.filter((response) => response.status === 201);
    expect(successes).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(
      8,
    );
    expect(
      responses
        .filter((response) => response.status === 409)
        .every(
          (response) => response.body.error.code === 'DUPLICATE_REFERENCE',
        ),
    ).toBe(true);

    expect(await getBalance(source.id)).toBe('90.00');
    expect(await getBalance(destination.id)).toBe('10.00');
    expect(await transferCount()).toBe(1);
    expect(await transferEntryCount()).toBe(2);
  });

  it('enforces global transfer reference uniqueness across concurrent account pairs', async () => {
    const sourceA = await createAccount('Source A');
    const sourceB = await createAccount('Source B');
    const destinationA = await createAccount('Destination A');
    const destinationB = await createAccount('Destination B');
    await createTransaction(sourceA.id, { type: 'credit', amount: '100.00' });
    await createTransaction(sourceB.id, { type: 'credit', amount: '100.00' });

    const referenceId = uniqueReference('concurrent-global-duplicate');

    const [first, second] = await Promise.all([
      api().post('/transfers').send({
        source_account_id: sourceA.id,
        destination_account_id: destinationA.id,
        amount: '10.00',
        reference_id: referenceId,
      }),
      api().post('/transfers').send({
        source_account_id: sourceB.id,
        destination_account_id: destinationB.id,
        amount: '10.00',
        reference_id: referenceId,
      }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);

    const successful = first.status === 201 ? first : second;
    const conflicted = first.status === 409 ? first : second;
    expect(conflicted.body.error.code).toBe('DUPLICATE_REFERENCE');
    expect(await transferCount()).toBe(1);
    expect(await transferEntryCount(successful.body.transfer_id)).toBe(2);
    expect(await transferEntryCount()).toBe(2);

    const winnerIsA = first.status === 201;
    const winnerSource = winnerIsA ? sourceA : sourceB;
    const loserSource = winnerIsA ? sourceB : sourceA;
    const loserDestination = winnerIsA ? destinationB : destinationA;

    expect(await getBalance(winnerSource.id)).toBe('90.00');
    expect(await getBalance(loserSource.id)).toBe('100.00');
    expect(await getBalance(loserDestination.id)).toBe('0.00');
  });

  it('serializes ordinary transactions and transfers on the same account', async () => {
    const source = await createAccount('Shared Source');
    const destination = await createAccount('Transfer Destination');
    await createTransaction(source.id, { type: 'credit', amount: '100.00' });

    const [debitResponse, transferResponse] = await Promise.all([
      api()
        .post(`/accounts/${source.id}/transactions`)
        .send({
          type: 'debit',
          amount: '60.00',
          reference_id: uniqueReference('competing-debit'),
        }),
      api().post('/transfers').send({
        source_account_id: source.id,
        destination_account_id: destination.id,
        amount: '50.00',
        reference_id: uniqueReference('competing-transfer'),
      }),
    ]);

    const statuses = [debitResponse.status, transferResponse.status].sort();
    expect(statuses).toEqual([201, 409]);

    if (debitResponse.status === 201) {
      expect(transferResponse.body.error.code).toBe('INSUFFICIENT_FUNDS');
      expect(await getBalance(source.id)).toBe('40.00');
      expect(await getBalance(destination.id)).toBe('0.00');
      expect(await transferCount()).toBe(0);
      expect((await getHistory(source.id)).pagination.total_records).toBe(2);
    } else {
      expect(debitResponse.body.error.code).toBe('INSUFFICIENT_FUNDS');
      expect(await getBalance(source.id)).toBe('50.00');
      expect(await getBalance(destination.id)).toBe('50.00');
      expect(await transferCount()).toBe(1);
      expect((await getHistory(source.id)).pagination.total_records).toBe(2);
      expect((await getHistory(destination.id)).pagination.total_records).toBe(
        1,
      );
    }
  });
});
