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

function cents(amount: string): bigint {
  const [whole = '0', fraction = ''] = amount.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

async function transferCount(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM transfers',
  );
  return Number(result.rows[0]?.count ?? '0');
}

describe('POST /transfers', () => {
  it('moves money atomically and exposes matching ledger entries', async () => {
    const source = await createAccount('Source');
    const destination = await createAccount('Destination');
    await createTransaction(source.id, {
      type: 'credit',
      amount: '100.00',
    });

    const transfer = await createTransfer({
      source_account_id: source.id,
      destination_account_id: destination.id,
      amount: '30.25',
      reference_id: '  rent-reference  ',
      description: 'Monthly rent',
    });

    expect(transfer).toMatchObject({
      source_balance: '69.75',
      destination_balance: '30.25',
      amount: '30.25',
      reference_id: 'rent-reference',
      description: 'Monthly rent',
    });
    expect(transfer.source_transaction_id).not.toBe(
      transfer.destination_transaction_id,
    );
    expect(new Date(transfer.created_at).toISOString()).toBe(
      transfer.created_at,
    );

    const ledger = await pool.query<{
      id: string;
      type: 'credit' | 'debit';
      account_id: string;
      reference_id: string;
    }>(
      `
        SELECT id, type, account_id, reference_id
        FROM transactions
        WHERE transfer_id = $1
        ORDER BY type
      `,
      [transfer.transfer_id],
    );

    expect(ledger.rows).toHaveLength(2);
    expect(ledger.rows).toEqual([
      {
        id: transfer.destination_transaction_id,
        type: 'credit',
        account_id: destination.id,
        reference_id: `transfer:${transfer.transfer_id}`,
      },
      {
        id: transfer.source_transaction_id,
        type: 'debit',
        account_id: source.id,
        reference_id: `transfer:${transfer.transfer_id}`,
      },
    ]);

    const sourceHistory = await getHistory(source.id);
    expect(sourceHistory.pagination.total_records).toBe(2);
    expect(sourceHistory.transactions[0]).toMatchObject({
      id: transfer.source_transaction_id,
      type: 'debit',
      amount: '30.25',
      transfer_id: transfer.transfer_id,
      description: 'Monthly rent',
    });
    expect(sourceHistory.transactions[1]?.transfer_id).toBeNull();

    const destinationHistory = await getHistory(destination.id);
    expect(destinationHistory.transactions).toHaveLength(1);
    expect(destinationHistory.transactions[0]).toMatchObject({
      id: transfer.destination_transaction_id,
      type: 'credit',
      amount: '30.25',
      transfer_id: transfer.transfer_id,
      description: 'Monthly rent',
    });

    expect(await getBalance(source.id)).toBe('69.75');
    expect(await getBalance(destination.id)).toBe('30.25');
    expect(cents('69.75') + cents('30.25')).toBe(cents('100.00'));
  });

  it('defaults the description to an empty string', async () => {
    const source = await createAccount();
    const destination = await createAccount();
    await createTransaction(source.id, { type: 'credit', amount: '10.00' });

    const transfer = await createTransfer({
      source_account_id: source.id,
      destination_account_id: destination.id,
      amount: '1',
    });

    expect(transfer.description).toBe('');
    expect(transfer.amount).toBe('1.00');

    const history = await getHistory(destination.id);
    expect(history.transactions[0]?.description).toBe('');
    expect(history.transactions[0]?.amount).toBe('1.00');
  });

  it('rejects transfers between the same account', async () => {
    const account = await createAccount();
    await createTransaction(account.id, { type: 'credit', amount: '10.00' });

    const response = await api().post('/transfers').send({
      source_account_id: account.id,
      destination_account_id: account.id,
      amount: '1.00',
      reference_id: uniqueReference('same-account'),
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(await getBalance(account.id)).toBe('10.00');
    expect(await transferCount()).toBe(0);
  });

  it('rejects missing, invalid, and overlapping accounts without changes', async () => {
    const missing = await api().post('/transfers').send({
      source_account_id: crypto.randomUUID(),
      destination_account_id: crypto.randomUUID(),
      amount: '1.00',
      reference_id: uniqueReference('missing'),
    });

    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('ACCOUNT_NOT_FOUND');
    expect(missing.body.error.details.accounts).toHaveLength(2);

    const source = await createAccount();
    const sourceMissingDestination = await api().post('/transfers').send({
      source_account_id: source.id,
      destination_account_id: crypto.randomUUID(),
      amount: '1.00',
      reference_id: uniqueReference('missing-destination'),
    });

    expect(sourceMissingDestination.status).toBe(404);
    expect(sourceMissingDestination.body.error.details.accounts).toEqual([
      expect.objectContaining({
        role: 'destination_account_id',
      }),
    ]);

    const invalid = await api().post('/transfers').send({
      source_account_id: 'not-a-uuid',
      destination_account_id: source.id,
      amount: '1.00',
      reference_id: uniqueReference('invalid'),
    });

    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
    expect(await transferCount()).toBe(0);
  });

  it.each([
    ['zero amount', { amount: '0.00' }],
    ['negative amount', { amount: '-1.00' }],
    ['fractional digits', { amount: '1.234' }],
    ['numeric amount', { amount: 1 }],
    ['empty reference', { reference_id: '   ' }],
    ['too-long reference', { reference_id: 'r'.repeat(201) }],
    ['too-long description', { description: 'd'.repeat(1001) }],
    ['client-supplied balance', { balance: '100.00' }],
    ['client-supplied id', { id: crypto.randomUUID() }],
    ['client-supplied timestamp', { created_at: new Date() }],
  ])('rejects %s', async (_label, override) => {
    const source = await createAccount();
    const destination = await createAccount();
    await createTransaction(source.id, { type: 'credit', amount: '10.00' });

    const response = await api()
      .post('/transfers')
      .send({
        source_account_id: source.id,
        destination_account_id: destination.id,
        amount: '1.00',
        reference_id: uniqueReference('invalid-body'),
        ...override,
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(await getBalance(source.id)).toBe('10.00');
    expect(await getBalance(destination.id)).toBe('0.00');
    expect(await transferCount()).toBe(0);
  });

  it('rejects insufficient funds without persisting anything', async () => {
    const source = await createAccount();
    const destination = await createAccount();
    await createTransaction(source.id, { type: 'credit', amount: '10.00' });

    const response = await api().post('/transfers').send({
      source_account_id: source.id,
      destination_account_id: destination.id,
      amount: '10.01',
      reference_id: uniqueReference('insufficient'),
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(await getBalance(source.id)).toBe('10.00');
    expect(await getBalance(destination.id)).toBe('0.00');
    expect(await transferCount()).toBe(0);

    const ledger = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM transactions WHERE transfer_id IS NOT NULL',
    );
    expect(ledger.rows[0]?.count).toBe('0');
  });

  it('rejects a destination balance overflow without persisting anything', async () => {
    const source = await createAccount();
    const destination = await createAccount();
    await createTransaction(source.id, { type: 'credit', amount: '100.00' });
    await createTransaction(destination.id, {
      type: 'credit',
      amount: '9999999999999999.99',
    });

    const response = await api().post('/transfers').send({
      source_account_id: source.id,
      destination_account_id: destination.id,
      amount: '0.01',
      reference_id: uniqueReference('destination-overflow'),
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('BALANCE_LIMIT_EXCEEDED');
    expect(await getBalance(source.id)).toBe('100.00');
    expect(await getBalance(destination.id)).toBe('9999999999999999.99');
    expect(await transferCount()).toBe(0);
  });

  it('rejects duplicate transfer references, including matching retries', async () => {
    const source = await createAccount();
    const destination = await createAccount();
    await createTransaction(source.id, { type: 'credit', amount: '100.00' });
    const referenceId = uniqueReference('duplicate-transfer');

    const first = await createTransfer({
      source_account_id: source.id,
      destination_account_id: destination.id,
      amount: '30.00',
      reference_id: referenceId,
    });

    const retry = await api().post('/transfers').send({
      source_account_id: source.id,
      destination_account_id: destination.id,
      amount: '30.00',
      reference_id: referenceId,
    });

    expect(retry.status).toBe(409);
    expect(retry.body.error.code).toBe('DUPLICATE_REFERENCE');
    expect(await getBalance(source.id)).toBe('70.00');
    expect(await getBalance(destination.id)).toBe('30.00');
    expect(await transferCount()).toBe(1);

    const ledger = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM transactions WHERE transfer_id = $1',
      [first.transfer_id],
    );
    expect(ledger.rows[0]?.count).toBe('2');
  });

  it('checks duplicate references before checking funds', async () => {
    const source = await createAccount();
    const destination = await createAccount();
    await createTransaction(source.id, { type: 'credit', amount: '100.00' });
    const referenceId = uniqueReference('duplicate-first');

    await createTransfer({
      source_account_id: source.id,
      destination_account_id: destination.id,
      amount: '100.00',
      reference_id: referenceId,
    });

    const retry = await api().post('/transfers').send({
      source_account_id: source.id,
      destination_account_id: destination.id,
      amount: '1.00',
      reference_id: referenceId,
    });

    expect(retry.status).toBe(409);
    expect(retry.body.error.code).toBe('DUPLICATE_REFERENCE');
    expect(await getBalance(source.id)).toBe('0.00');
    expect(await transferCount()).toBe(1);
  });

  it('enforces globally unique transfer references across account pairs', async () => {
    const sourceA = await createAccount('Source A');
    const sourceB = await createAccount('Source B');
    const destinationA = await createAccount('Destination A');
    const destinationB = await createAccount('Destination B');

    await createTransaction(sourceA.id, { type: 'credit', amount: '100.00' });
    await createTransaction(sourceB.id, { type: 'credit', amount: '100.00' });

    const referenceId = uniqueReference('global-duplicate');

    await createTransfer({
      source_account_id: sourceA.id,
      destination_account_id: destinationA.id,
      amount: '10.00',
      reference_id: referenceId,
    });

    const response = await api().post('/transfers').send({
      source_account_id: sourceB.id,
      destination_account_id: destinationB.id,
      amount: '10.00',
      reference_id: referenceId,
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('DUPLICATE_REFERENCE');
    expect(await getBalance(sourceB.id)).toBe('100.00');
    expect(await getBalance(destinationB.id)).toBe('0.00');
    expect(await transferCount()).toBe(1);
  });

  it('rejects malformed JSON', async () => {
    const response = await api()
      .post('/transfers')
      .set('Content-Type', 'application/json')
      .send('{"source_account_id":');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_JSON');
  });
});
