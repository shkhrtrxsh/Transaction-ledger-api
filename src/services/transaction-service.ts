import { pool } from '../db/pool';
import { rollbackQuietly } from '../db/helpers';
import { isUniqueViolation } from '../errors/database';
import { AppError } from '../errors/app-error';
import { MAX_MONEY } from '../domain/money';
import type {
  CreateTransactionBody,
  TransactionHistoryQuery,
} from '../validation/schemas';
import {
  serializeTransactionRow,
  type TransactionResponse,
  type TransactionRow,
} from './transaction-serializer';

export interface TransactionHistoryResponse {
  account_id: string;
  transactions: TransactionResponse[];
  pagination: {
    current_page: number;
    page_size: number;
    total_records: number;
    total_pages: number;
  };
}

const TRANSACTION_COLUMNS = `
  id,
  account_id,
  type,
  amount::text AS amount,
  description,
  reference_id,
  transfer_id,
  created_at
`;

export async function createTransaction(
  accountId: string,
  input: CreateTransactionBody,
): Promise<{ transaction: TransactionResponse; balance: string }> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const account = await client.query<{ id: string }>(
      'SELECT id FROM accounts WHERE id = $1 FOR UPDATE',
      [accountId],
    );

    if ((account.rowCount ?? 0) === 0) {
      throw new AppError(
        404,
        'ACCOUNT_NOT_FOUND',
        `Account ${accountId} was not found`,
      );
    }

    // Check duplicates before funds so a retry of an existing debit reports the
    // reference conflict even if the original transaction spent the balance.
    const duplicate = await client.query(
      `
        SELECT 1
        FROM transactions
        WHERE account_id = $1 AND reference_id = $2
        LIMIT 1
      `,
      [accountId, input.reference_id],
    );

    if ((duplicate.rowCount ?? 0) > 0) {
      throw new AppError(
        409,
        'DUPLICATE_REFERENCE',
        'A transaction with this reference_id already exists for this account',
      );
    }

    const balanceResult =
      input.type === 'debit'
        ? await client.query<{ balance: string }>(
            `
              UPDATE accounts
              SET balance = balance - $2::numeric
              WHERE id = $1 AND balance >= $2::numeric
              RETURNING balance::text AS balance
            `,
            [accountId, input.amount],
          )
        : await client.query<{ balance: string }>(
            `
              UPDATE accounts
              SET balance = balance + $2::numeric
              WHERE id = $1 AND balance <= $3::numeric - $2::numeric
              RETURNING balance::text AS balance
            `,
            [accountId, input.amount, MAX_MONEY],
          );

    const updatedBalance = balanceResult.rows[0];
    if (!updatedBalance) {
      if (input.type === 'debit') {
        throw new AppError(
          409,
          'INSUFFICIENT_FUNDS',
          'The account has insufficient funds for this debit',
        );
      }

      throw new AppError(
        409,
        'BALANCE_LIMIT_EXCEEDED',
        'The resulting account balance exceeds the supported maximum',
      );
    }

    const inserted = await client.query<TransactionRow>(
      `
        INSERT INTO transactions (
          account_id,
          type,
          amount,
          description,
          reference_id
        )
        VALUES ($1, $2, $3::numeric, $4, $5)
        RETURNING ${TRANSACTION_COLUMNS}
      `,
      [
        accountId,
        input.type,
        input.amount,
        input.description,
        input.reference_id,
      ],
    );

    const response = {
      transaction: serializeTransactionRow(inserted.rows[0]!),
      balance: updatedBalance.balance,
    };

    await client.query('COMMIT');
    return response;
  } catch (error) {
    await rollbackQuietly(client);

    if (isUniqueViolation(error)) {
      throw new AppError(
        409,
        'DUPLICATE_REFERENCE',
        'A transaction with this reference_id already exists for this account',
      );
    }

    throw error;
  } finally {
    client.release();
  }
}

export async function listTransactions(
  accountId: string,
  query: TransactionHistoryQuery,
): Promise<TransactionHistoryResponse> {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const offset = (page - 1) * limit;

  const client = await pool.connect();

  try {
    await client.query(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );

    const account = await client.query(
      'SELECT 1 FROM accounts WHERE id = $1',
      [accountId],
    );

    if ((account.rowCount ?? 0) === 0) {
      throw new AppError(
        404,
        'ACCOUNT_NOT_FOUND',
        `Account ${accountId} was not found`,
      );
    }

    const filterParameters: unknown[] = [accountId];
    let whereClause = 'account_id = $1';

    if (query.type) {
      filterParameters.push(query.type);
      whereClause += ` AND type = $${filterParameters.length}`;
    }

    const countResult = await client.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM transactions WHERE ${whereClause}`,
      filterParameters,
    );

    const rows = await client.query<TransactionRow>(
      `
        SELECT ${TRANSACTION_COLUMNS}
        FROM transactions
        WHERE ${whereClause}
        ORDER BY created_at DESC, id DESC
        LIMIT $${filterParameters.length + 1}
        OFFSET $${filterParameters.length + 2}
      `,
      [...filterParameters, limit, offset],
    );

    const totalRecords = Number(countResult.rows[0]?.total ?? '0');

    const response: TransactionHistoryResponse = {
      account_id: accountId,
      transactions: rows.rows.map(serializeTransactionRow),
      pagination: {
        current_page: page,
        page_size: limit,
        total_records: totalRecords,
        total_pages:
          totalRecords === 0 ? 0 : Math.ceil(totalRecords / limit),
      },
    };

    await client.query('COMMIT');
    return response;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}
