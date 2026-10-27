import { describe, expect, it } from 'vitest';
import {
  api,
  createAccount,
  createTransaction,
  getBalance,
  getHistory,
  uniqueReference,
} from './helpers';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('POST /accounts/:accountId/transactions', () => {
  it('credits and debits with exact decimal arithmetic', async () => {
    const account = await createAccount('Ledger Owner');

    const credit = await createTransaction(account.id, {
      type: 'credit',
      amount: '100.50',
    });

    expect(credit.balance).toBe('100.50');
    expect(credit.transaction).toMatchObject({
      account_id: account.id,
      type: 'credit',
      amount: '100.50',
      description: '',
      transfer_id: null,
    });
    expect(credit.transaction.id).toMatch(UUID_PATTERN);
    expect(credit.transaction.reference_id).toMatch(/^credit-/);
    expect(new Date(credit.transaction.created_at).toISOString()).toBe(
      credit.transaction.created_at,
    );

    const debit = await createTransaction(account.id, {
      type: 'debit',
      amount: '40.25',
      description: 'Office supplies',
    });

    expect(debit.balance).toBe('60.25');
    expect(debit.transaction.description).toBe('Office supplies');
    expect(await getBalance(account.id)).toBe('60.25');
  });

  it('handles fractional amounts without floating-point drift', async () => {
    const account = await createAccount();

    await createTransaction(account.id, { type: 'credit', amount: '0.10' });
    await createTransaction(account.id, { type: 'credit', amount: '0.20' });
    const debit = await createTransaction(account.id, {
      type: 'debit',
      amount: '0.05',
    });

    expect(debit.balance).toBe('0.25');
  });

  it('trims reference ids and accepts a 200-character description', async () => {
    const account = await createAccount();
    const description = 'd'.repeat(1000);

    const result = await createTransaction(account.id, {
      type: 'credit',
      amount: '1.00',
      reference_id: '  trimmed-reference  ',
      description,
    });

    expect(result.transaction.reference_id).toBe('trimmed-reference');
    expect(result.transaction.description).toBe(description);
  });

  it('accepts the maximum supported amount and rejects overflow in the balance', async () => {
    const account = await createAccount();

    const maxCredit = await createTransaction(account.id, {
      type: 'credit',
      amount: '9999999999999999.99',
    });

    expect(maxCredit.balance).toBe('9999999999999999.99');

    const response = await api()
      .post(`/accounts/${account.id}/transactions`)
      .send({
        type: 'credit',
        amount: '0.01',
        reference_id: uniqueReference('overflow'),
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('BALANCE_LIMIT_EXCEEDED');
    expect(await getBalance(account.id)).toBe('9999999999999999.99');
  });

  it('rejects a debit when funds are insufficient and leaves state unchanged', async () => {
    const account = await createAccount();
    await createTransaction(account.id, {
      type: 'credit',
      amount: '10.00',
    });

    const response = await api()
      .post(`/accounts/${account.id}/transactions`)
      .send({
        type: 'debit',
        amount: '10.01',
        reference_id: uniqueReference('too-much'),
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(await getBalance(account.id)).toBe('10.00');

    const history = await getHistory(account.id);
    expect(history.pagination.total_records).toBe(1);
  });

  it('rejects duplicate references per account without changing the balance', async () => {
    const account = await createAccount();
    const referenceId = uniqueReference('duplicate');

    await createTransaction(account.id, {
      type: 'credit',
      amount: '5.00',
      reference_id: referenceId,
    });

    const response = await api()
      .post(`/accounts/${account.id}/transactions`)
      .send({
        type: 'credit',
        amount: '5.00',
        reference_id: referenceId,
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('DUPLICATE_REFERENCE');
    expect(await getBalance(account.id)).toBe('5.00');
    expect((await getHistory(account.id)).pagination.total_records).toBe(1);
  });

  it('checks duplicate references before checking funds', async () => {
    const account = await createAccount();
    const referenceId = uniqueReference('duplicate-first');

    await createTransaction(account.id, {
      type: 'credit',
      amount: '1.00',
      reference_id: referenceId,
    });

    const response = await api()
      .post(`/accounts/${account.id}/transactions`)
      .send({
        type: 'debit',
        amount: '100.00',
        reference_id: referenceId,
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('DUPLICATE_REFERENCE');
  });

  it('allows the same reference id for different accounts', async () => {
    const first = await createAccount('First');
    const second = await createAccount('Second');
    const referenceId = uniqueReference('shared');

    const firstResult = await createTransaction(first.id, {
      type: 'credit',
      amount: '5.00',
      reference_id: referenceId,
    });
    const secondResult = await createTransaction(second.id, {
      type: 'credit',
      amount: '7.00',
      reference_id: referenceId,
    });

    expect(firstResult.transaction.reference_id).toBe(referenceId);
    expect(secondResult.transaction.reference_id).toBe(referenceId);
    expect(await getBalance(second.id)).toBe('7.00');
  });

  it('rejects the reserved transfer reference prefix', async () => {
    const account = await createAccount();

    const response = await api()
      .post(`/accounts/${account.id}/transactions`)
      .send({
        type: 'credit',
        amount: '1.00',
        reference_id: '  transfer:not-allowed  ',
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it.each([
    ['zero', '0'],
    ['zero with decimals', '0.00'],
    ['negative', '-1.00'],
    ['too many decimals', '1.234'],
    ['leading zero', '01.00'],
    ['exponent notation', '1e2'],
    ['missing integer part', '.50'],
    ['missing fraction part', '100.'],
    ['surrounding whitespace', ' 100.00'],
    ['trailing newline', '100.00\n'],
    ['plus sign', '+100.00'],
    ['too many integer digits', '10000000000000000.00'],
    ['non-numeric text', 'abc'],
    ['empty string', ''],
  ])('rejects an amount with %s', async (_label, amount) => {
    const account = await createAccount();

    const response = await api()
      .post(`/accounts/${account.id}/transactions`)
      .send({
        type: 'credit',
        amount,
        reference_id: uniqueReference('bad-amount'),
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it.each([
    ['numeric amount', { type: 'credit', amount: 100 }],
    ['null amount', { type: 'credit', amount: null }],
    ['invalid type', { type: 'transfer', amount: '1.00' }],
    ['missing type', { amount: '1.00' }],
    ['missing amount', { type: 'credit' }],
    ['unknown balance field', { type: 'credit', amount: '1.00', balance: '5.00' }],
    ['unknown id field', { type: 'credit', amount: '1.00', id: crypto.randomUUID() }],
    ['unknown transfer id field', { type: 'credit', amount: '1.00', transfer_id: crypto.randomUUID() }],
    ['unknown timestamp field', { type: 'credit', amount: '1.00', created_at: new Date() }],
    ['unknown account field', { type: 'credit', amount: '1.00', account_id: crypto.randomUUID() }],
    ['non-string description', { type: 'credit', amount: '1.00', description: 5 }],
    ['too-long description', { type: 'credit', amount: '1.00', description: 'd'.repeat(1001) }],
    ['empty reference', { type: 'credit', amount: '1.00', reference_id: '   ' }],
    ['non-string reference', { type: 'credit', amount: '1.00', reference_id: 7 }],
    ['too-long reference', { type: 'credit', amount: '1.00', reference_id: 'r'.repeat(201) }],
  ])('rejects %s', async (_label, body) => {
    const account = await createAccount();

    const response = await api()
      .post(`/accounts/${account.id}/transactions`)
      .send({ ...body, reference_id: 'reference_id' in body ? body.reference_id : uniqueReference() });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for a missing account and 400 for an invalid account id', async () => {
    const missing = await api()
      .post(`/accounts/${crypto.randomUUID()}/transactions`)
      .send({
        type: 'credit',
        amount: '1.00',
        reference_id: uniqueReference(),
      });

    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('ACCOUNT_NOT_FOUND');

    const invalid = await api()
      .post('/accounts/not-a-uuid/transactions')
      .send({
        type: 'credit',
        amount: '1.00',
        reference_id: uniqueReference(),
      });

    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
  });
});
