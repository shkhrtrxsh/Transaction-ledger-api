import { pool } from '../db/pool';
import { toIsoTimestamp } from '../db/helpers';
import { AppError } from '../errors/app-error';

interface AccountRow {
  id: string;
  name: string;
  balance: string;
  created_at: Date | string;
}

export interface AccountResponse {
  id: string;
  name: string;
  balance: string;
  created_at: string;
}

function serializeAccount(row: AccountRow): AccountResponse {
  return {
    id: row.id,
    name: row.name,
    balance: row.balance,
    created_at: toIsoTimestamp(row.created_at),
  };
}

export async function createAccount(name: string): Promise<AccountResponse> {
  const result = await pool.query<AccountRow>(
    `
      INSERT INTO accounts (name)
      VALUES ($1)
      RETURNING id, name, balance::text AS balance, created_at
    `,
    [name],
  );

  return serializeAccount(result.rows[0]!);
}

export async function getAccountBalance(
  accountId: string,
): Promise<{ account_id: string; balance: string }> {
  const result = await pool.query<{ id: string; balance: string }>(
    'SELECT id, balance::text AS balance FROM accounts WHERE id = $1',
    [accountId],
  );

  const account = result.rows[0];
  if (!account) {
    throw new AppError(
      404,
      'ACCOUNT_NOT_FOUND',
      `Account ${accountId} was not found`,
    );
  }

  return {
    account_id: account.id,
    balance: account.balance,
  };
}
