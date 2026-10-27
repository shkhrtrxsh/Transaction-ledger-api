import express from 'express';
import { accountsRouter } from './routes/accounts';
import { transfersRouter } from './routes/transfers';
import {
  errorHandler,
  notFoundHandler,
} from './middleware/error-handler';

export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.use('/accounts', accountsRouter);
  app.use('/transfers', transfersRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export const app = createApp();
