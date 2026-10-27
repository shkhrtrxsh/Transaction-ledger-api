import dotenv from 'dotenv';

dotenv.config({ quiet: true });

function readInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: readInteger('PORT', 3000),
  databaseUrl:
    process.env.DATABASE_URL ??
    'postgres://postgres:postgres@localhost:5432/transaction_ledger',
  dbPoolMax: readInteger('DB_POOL_MAX', 10),
};
