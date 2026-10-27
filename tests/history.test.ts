import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { api, createAccount, getHistory } from './helpers';

async function seedHistory(accountId: string, count: number): Promise<void> {
  const base = Date.parse('2026-01-01T00:00:00.000Z');

  for (let index = 0; index < count; index += 1) {
    await pool.query(
      `
        INSERT INTO transactions (
          account_id,
          type,
          amount,
          description,
          reference_id,
          created_at
        )
        VALUES ($1, $2, '1.00', '', $3, $4)
      `,
      [
        accountId,
        index % 2 === 0 ? 'credit' : 'debit',
        `seed-${index}`,
        new Date(base + index * 1000),
      ],
    );
  }
}

describe('GET /accounts/:accountId/transactions', () => {
  it('returns an empty first page for an account with no transactions', async () => {
    const account = await createAccount();
    const history = await getHistory(account.id);

    expect(history).toEqual({
      account_id: account.id,
      transactions: [],
      pagination: {
        current_page: 1,
        page_size: 20,
        total_records: 0,
        total_pages: 0,
      },
    });
  });

  it('paginates in latest-first order with consistent metadata', async () => {
    const account = await createAccount();
    await seedHistory(account.id, 25);

    const firstPage = await getHistory(account.id);
    expect(firstPage.pagination).toEqual({
      current_page: 1,
      page_size: 20,
      total_records: 25,
      total_pages: 2,
    });
    expect(firstPage.transactions).toHaveLength(20);
    expect(firstPage.transactions[0]?.reference_id).toBe('seed-24');
    expect(firstPage.transactions[19]?.reference_id).toBe('seed-5');

    const secondPage = await getHistory(account.id, { page: 2 });
    expect(secondPage.pagination).toEqual({
      current_page: 2,
      page_size: 20,
      total_records: 25,
      total_pages: 2,
    });
    expect(secondPage.transactions).toHaveLength(5);
    expect(secondPage.transactions[0]?.reference_id).toBe('seed-4');
    expect(secondPage.transactions[4]?.reference_id).toBe('seed-0');

    const beyond = await getHistory(account.id, { page: 3 });
    expect(beyond.transactions).toEqual([]);
    expect(beyond.pagination).toEqual({
      current_page: 3,
      page_size: 20,
      total_records: 25,
      total_pages: 2,
    });
  });

  it('filters by type and respects the limit', async () => {
    const account = await createAccount();
    await seedHistory(account.id, 25);

    const credits = await getHistory(account.id, {
      type: 'credit',
      limit: 100,
    });

    expect(credits.pagination).toEqual({
      current_page: 1,
      page_size: 100,
      total_records: 13,
      total_pages: 1,
    });
    expect(credits.transactions).toHaveLength(13);
    expect(credits.transactions.every((item) => item.type === 'credit')).toBe(
      true,
    );

    const debits = await getHistory(account.id, {
      type: 'debit',
      page: 2,
      limit: 10,
    });

    expect(debits.pagination).toEqual({
      current_page: 2,
      page_size: 10,
      total_records: 12,
      total_pages: 2,
    });
    expect(debits.transactions).toHaveLength(2);
    expect(debits.transactions.every((item) => item.type === 'debit')).toBe(
      true,
    );
  });

  it('breaks created_at ties by descending id', async () => {
    const account = await createAccount();
    const createdAt = new Date('2026-02-01T12:00:00.000Z');

    await pool.query(
      `
        INSERT INTO transactions (id, account_id, type, amount, reference_id, created_at)
        VALUES
          ('11111111-1111-4111-8111-111111111111', $1, 'credit', 1.00, 'tie-low', $2),
          ('22222222-2222-4222-8222-222222222222', $1, 'credit', 1.00, 'tie-high', $2)
      `,
      [account.id, createdAt],
    );

    const history = await getHistory(account.id);

    expect(history.transactions.map((item) => item.id)).toEqual([
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
    ]);
  });

  it.each([
    ['page zero', { page: 0 }],
    ['negative page', { page: -1 }],
    ['non-numeric page', { page: 'abc' }],
    ['fractional page', { page: '1.5' }],
    ['empty page', { page: '' }],
    ['zero limit', { limit: 0 }],
    ['limit above 100', { limit: 101 }],
    ['fractional limit', { limit: '2.5' }],
    ['invalid type', { type: 'transfer' }],
    ['uppercase type', { type: 'CREDIT' }],
  ])('rejects %s', async (_label, query) => {
    const account = await createAccount();
    const response = await api()
      .get(`/accounts/${account.id}/transactions`)
      .query(query);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for a missing account and 400 for an invalid id', async () => {
    const missing = await api().get(
      `/accounts/${crypto.randomUUID()}/transactions`,
    );

    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('ACCOUNT_NOT_FOUND');

    const invalid = await api().get('/accounts/not-a-uuid/transactions');

    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
  });
});
