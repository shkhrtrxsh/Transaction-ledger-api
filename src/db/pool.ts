import { Pool, types } from 'pg';
import { config } from '../config';

// PostgreSQL NUMERIC values are handled as strings so money never passes
// through a JavaScript floating-point number.
types.setTypeParser(1700, (value) => value);

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
});

pool.on('error', (error) => {
  console.error('Unexpected idle PostgreSQL client error', error);
});
