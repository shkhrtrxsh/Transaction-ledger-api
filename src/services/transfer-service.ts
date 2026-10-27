import { pool } from '../db/pool';
import { rollbackQuietly, toIsoTimestamp } from '../db/helpers';
import { isUniqueViolation } from '../errors/database';
import { AppError } from '../errors/app-error';
import { MAX_MONEY } from '../domain/money';
import type { CreateTransferBody } from '../validation/schemas';
import type { TransactionRow } from './transaction-serializer';

interface TransferRow {
  id: string;
  amount: string;
  created_at: Date | string;
}

interface AccountLockTarget {
  id: string;
  role: 'source_account_id' | 'destination_account_id';
}

export interface TransferResponse {
  transfer_id: string;
  source_transaction_id: string;
  destination_transaction_id: string;
  source_balance: string;
  destination_balance: string;
  amount: string;
  reference_id: string;
  description: string;
  created_at: string;
}

export async function createTransfer(
  input: CreateTransferBody,
): Promise<TransferResponse> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Always lock in ascending UUID order so opposite-direction transfers
    // cannot deadlock by acquiring the same two rows in opposite orders.
    const lockTargets: AccountLockTarget[] = (
      [
        { id: input.source_account_id, role: 'source_account_id' },
        { id: input.destination_account_id, role: 'destination_account_id' },
      ] satisfies AccountLockTarget[]
    ).sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );

    const missingAccounts: AccountLockTarget[] = [];

    for (const target of lockTargets) {
      const account = await client.query(
        'SELECT id FROM accounts WHERE id = $1 FOR UPDATE',
        [target.id],
      );

      if ((account.rowCount ?? 0) === 0) {
        missingAccounts.push(target);
      }
    }

    if (missingAccounts.length > 0) {
      throw new AppError(
        404,
        'ACCOUNT_NOT_FOUND',
        'One or more accounts were not found',
        {
          accounts: missingAccounts.map((account) => ({
            role: account.role,
            account_id: account.id,
          })),
        },
      );
    }

    // The reference is checked before funds so retries always report the
    // conflict, even when the original transfer emptied the source account.
    const duplicate = await client.query(
      'SELECT 1 FROM transfers WHERE reference_id = $1 LIMIT 1',
      [input.reference_id],
    );

    if ((duplicate.rowCount ?? 0) > 0) {
      throw new AppError(
        409,
        'DUPLICATE_REFERENCE',
        'A transfer with this reference_id already exists',
      );
    }

    const limits = await client.query<{
      source_has_funds: boolean;
      destination_fits: boolean;
    }>(
      `
        SELECT
          (SELECT balance FROM accounts WHERE id = $1) >= $3::numeric
            AS source_has_funds,
          (SELECT balance FROM accounts WHERE id = $2) + $3::numeric
            <= $4::numeric AS destination_fits
      `,
      [
        input.source_account_id,
        input.destination_account_id,
        input.amount,
        MAX_MONEY,
      ],
    );

    const limitCheck = limits.rows[0]!;

    if (!limitCheck.source_has_funds) {
      throw new AppError(
        409,
        'INSUFFICIENT_FUNDS',
        'The source account has insufficient funds for this transfer',
      );
    }

    if (!limitCheck.destination_fits) {
      throw new AppError(
        409,
        'BALANCE_LIMIT_EXCEEDED',
        'The resulting destination balance exceeds the supported maximum',
      );
    }

    const transfer = await client.query<TransferRow>(
      `
        INSERT INTO transfers (
          source_account_id,
          destination_account_id,
          amount,
          reference_id,
          description
        )
        VALUES ($1, $2, $3::numeric, $4, $5)
        RETURNING id, amount::text AS amount, created_at
      `,
      [
        input.source_account_id,
        input.destination_account_id,
        input.amount,
        input.reference_id,
        input.description,
      ],
    );

    const transferRow = transfer.rows[0]!;
    const ledgerReference = `transfer:${transferRow.id}`;

    const sourceBalance = await client.query<{ balance: string }>(
      `
        UPDATE accounts
        SET balance = balance - $2::numeric
        WHERE id = $1
        RETURNING balance::text AS balance
      `,
      [input.source_account_id, input.amount],
    );

    const destinationBalance = await client.query<{ balance: string }>(
      `
        UPDATE accounts
        SET balance = balance + $2::numeric
        WHERE id = $1
        RETURNING balance::text AS balance
      `,
      [input.destination_account_id, input.amount],
    );

    if (!sourceBalance.rows[0] || !destinationBalance.rows[0]) {
      throw new Error('Transfer balance update did not affect both accounts');
    }

    const sourceTransaction = await client.query<TransactionRow>(
      `
        INSERT INTO transactions (
          account_id,
          type,
          amount,
          description,
          reference_id,
          transfer_id
        )
        VALUES ($1, 'debit', $2::numeric, $3, $4, $5)
        RETURNING
          id,
          account_id,
          type,
          amount::text AS amount,
          description,
          reference_id,
          transfer_id,
          created_at
      `,
      [
        input.source_account_id,
        input.amount,
        input.description,
        ledgerReference,
        transferRow.id,
      ],
    );

    const destinationTransaction = await client.query<TransactionRow>(
      `
        INSERT INTO transactions (
          account_id,
          type,
          amount,
          description,
          reference_id,
          transfer_id
        )
        VALUES ($1, 'credit', $2::numeric, $3, $4, $5)
        RETURNING
          id,
          account_id,
          type,
          amount::text AS amount,
          description,
          reference_id,
          transfer_id,
          created_at
      `,
      [
        input.destination_account_id,
        input.amount,
        input.description,
        ledgerReference,
        transferRow.id,
      ],
    );

    const sourceTransactionRow = sourceTransaction.rows[0]!;
    const destinationTransactionRow = destinationTransaction.rows[0]!;

    const response: TransferResponse = {
      transfer_id: transferRow.id,
      source_transaction_id: sourceTransactionRow.id,
      destination_transaction_id: destinationTransactionRow.id,
      source_balance: sourceBalance.rows[0].balance,
      destination_balance: destinationBalance.rows[0].balance,
      amount: transferRow.amount,
      reference_id: input.reference_id,
      description: input.description,
      created_at: toIsoTimestamp(transferRow.created_at),
    };

    await client.query('COMMIT');
    return response;
  } catch (error) {
    await rollbackQuietly(client);

    if (isUniqueViolation(error)) {
      throw new AppError(
        409,
        'DUPLICATE_REFERENCE',
        'A transfer with this reference_id already exists',
      );
    }

    throw error;
  } finally {
    client.release();
  }
}
