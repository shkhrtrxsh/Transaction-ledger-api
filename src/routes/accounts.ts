import { Router } from 'express';
import {
  createAccountBodySchema,
  accountParamsSchema,
  createTransactionBodySchema,
  transactionHistoryQuerySchema,
  parseOrThrow,
} from '../validation/schemas';
import {
  createAccount,
  getAccountBalance,
} from '../services/account-service';
import {
  createTransaction,
  listTransactions,
} from '../services/transaction-service';

export const accountsRouter = Router();

accountsRouter.post('/', async (request, response) => {
  const body = parseOrThrow(createAccountBodySchema, request.body);
  const account = await createAccount(body.name);

  response.status(201).json(account);
});

accountsRouter.get('/:accountId/balance', async (request, response) => {
  const { accountId } = parseOrThrow(accountParamsSchema, request.params);
  const balance = await getAccountBalance(accountId);

  response.json(balance);
});

accountsRouter.post('/:accountId/transactions', async (request, response) => {
  const { accountId } = parseOrThrow(accountParamsSchema, request.params);
  const body = parseOrThrow(createTransactionBodySchema, request.body);
  const result = await createTransaction(accountId, body);

  response.status(201).json(result);
});

accountsRouter.get('/:accountId/transactions', async (request, response) => {
  const { accountId } = parseOrThrow(accountParamsSchema, request.params);
  const query = parseOrThrow(transactionHistoryQuerySchema, request.query);
  const result = await listTransactions(accountId, query);

  response.json(result);
});
