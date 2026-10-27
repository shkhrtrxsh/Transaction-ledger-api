import { Router } from 'express';
import {
  createTransferBodySchema,
  parseOrThrow,
} from '../validation/schemas';
import { createTransfer } from '../services/transfer-service';

export const transfersRouter = Router();

transfersRouter.post('/', async (request, response) => {
  const body = parseOrThrow(createTransferBodySchema, request.body);
  const transfer = await createTransfer(body);

  response.status(201).json(transfer);
});
