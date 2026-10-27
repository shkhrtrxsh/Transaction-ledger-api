import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../src/app';

export interface AccountResponse {
  id: string;
  name: string;
  balance: string;
  created_at: string;
}

export interface TransactionResponse {
  id: string;
  account_id: string;
  type: 'credit' | 'debit';
  amount: string;
  description: string;
  reference_id: string;
  transfer_id: string | null;
  created_at: string;
}

export interface TransactionResult {
  transaction: TransactionResponse;
  balance: string;
}

export interface HistoryResponse {
  account_id: string;
  transactions: TransactionResponse[];
  pagination: {
    current_page: number;
    page_size: number;
    total_records: number;
    total_pages: number;
  };
}

export interface TransferResult {
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

export function uniqueReference(prefix = 'ref'): string {
  return `${prefix}-${randomUUID()}`;
}

export function api(): request.Agent {
  return request(app);
}

export async function createAccount(
  name = 'Test Account',
): Promise<AccountResponse> {
  const response = await api().post('/accounts').send({ name });

  if (response.status !== 201) {
    throw new Error(
      `Failed to create account: ${response.status} ${JSON.stringify(response.body)}`,
    );
  }

  return response.body as AccountResponse;
}

export async function createTransaction(
  accountId: string,
  input: {
    type: 'credit' | 'debit';
    amount: string;
    reference_id?: string;
    description?: string;
  },
): Promise<TransactionResult> {
  const response = await api()
    .post(`/accounts/${accountId}/transactions`)
    .send({
      ...input,
      reference_id: input.reference_id ?? uniqueReference(input.type),
    });

  if (response.status !== 201) {
    throw new Error(
      `Failed to create transaction: ${response.status} ${JSON.stringify(response.body)}`,
    );
  }

  return response.body as TransactionResult;
}

export async function getBalance(accountId: string): Promise<string> {
  const response = await api().get(`/accounts/${accountId}/balance`);

  if (response.status !== 200) {
    throw new Error(
      `Failed to read balance: ${response.status} ${JSON.stringify(response.body)}`,
    );
  }

  return (response.body as { account_id: string; balance: string }).balance;
}

export async function getHistory(
  accountId: string,
  query: Record<string, string | number> = {},
): Promise<HistoryResponse> {
  const response = await api()
    .get(`/accounts/${accountId}/transactions`)
    .query(query);

  if (response.status !== 200) {
    throw new Error(
      `Failed to read history: ${response.status} ${JSON.stringify(response.body)}`,
    );
  }

  return response.body as HistoryResponse;
}

export async function createTransfer(input: {
  source_account_id: string;
  destination_account_id: string;
  amount: string;
  reference_id?: string;
  description?: string;
}): Promise<TransferResult> {
  const response = await api()
    .post('/transfers')
    .send({
      ...input,
      reference_id: input.reference_id ?? uniqueReference('transfer'),
    });

  if (response.status !== 201) {
    throw new Error(
      `Failed to create transfer: ${response.status} ${JSON.stringify(response.body)}`,
    );
  }

  return response.body as TransferResult;
}
