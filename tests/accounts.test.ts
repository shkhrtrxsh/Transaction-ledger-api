import { describe, expect, it } from 'vitest';
import { api, createAccount } from './helpers';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('POST /accounts', () => {
  it('creates an account with a zero balance and returns 201', async () => {
    const response = await api()
      .post('/accounts')
      .send({ name: '  Alice Example  ' });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      name: 'Alice Example',
      balance: '0.00',
    });
    expect(response.body.id).toMatch(UUID_PATTERN);
    expect(new Date(response.body.created_at).toISOString()).toBe(
      response.body.created_at,
    );
  });

  it('accepts a 200-character name', async () => {
    const name = 'a'.repeat(200);
    const response = await api().post('/accounts').send({ name });

    expect(response.status).toBe(201);
    expect(response.body.name).toBe(name);
  });

  it('rejects a client-supplied initial balance', async () => {
    const response = await api()
      .post('/accounts')
      .send({ name: 'Alice', balance: '100.00' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it.each([
    ['missing name', {}],
    ['empty name', { name: '' }],
    ['whitespace-only name', { name: '   ' }],
    ['non-string name', { name: 42 }],
    ['null name', { name: null }],
    ['201-character name', { name: 'a'.repeat(201) }],
    ['client-supplied id', { name: 'Alice', id: crypto.randomUUID() }],
    ['client-supplied timestamp', { name: 'Alice', created_at: new Date() }],
  ])('rejects %s', async (_label, body) => {
    const response = await api().post('/accounts').send(body);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects malformed JSON', async () => {
    const response = await api()
      .post('/accounts')
      .set('Content-Type', 'application/json')
      .send('{"name":');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: 'INVALID_JSON',
        message: 'Request body contains malformed JSON',
      },
    });
  });
});

describe('GET /accounts/:accountId/balance', () => {
  it('returns the current balance', async () => {
    const account = await createAccount('Balance Owner');
    const response = await api().get(`/accounts/${account.id}/balance`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      account_id: account.id,
      balance: '0.00',
    });
  });

  it('returns 404 for a missing account', async () => {
    const response = await api().get(
      `/accounts/${crypto.randomUUID()}/balance`,
    );

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('ACCOUNT_NOT_FOUND');
  });

  it('returns 400 for an invalid account id', async () => {
    const response = await api().get('/accounts/not-a-uuid/balance');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});
