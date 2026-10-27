import { toIsoTimestamp } from '../db/helpers';

export type TransactionType = 'credit' | 'debit';

export interface TransactionRow {
  id: string;
  account_id: string;
  type: TransactionType;
  amount: string;
  description: string;
  reference_id: string;
  transfer_id: string | null;
  created_at: Date | string;
}

export interface TransactionResponse {
  id: string;
  account_id: string;
  type: TransactionType;
  amount: string;
  description: string;
  reference_id: string;
  transfer_id: string | null;
  created_at: string;
}

export function serializeTransactionRow(
  row: TransactionRow,
): TransactionResponse {
  return {
    id: row.id,
    account_id: row.account_id,
    type: row.type,
    amount: row.amount,
    description: row.description,
    reference_id: row.reference_id,
    transfer_id: row.transfer_id,
    created_at: toIsoTimestamp(row.created_at),
  };
}
