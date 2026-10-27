import { app } from './app';
import { config } from './config';
import { pool } from './db/pool';

const server = app.listen(config.port, () => {
  console.log(`Transaction ledger API listening on port ${config.port}`);
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.log(`Received ${signal}; shutting down`);

  const forceExitTimer = setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();

  server.close(async (error) => {
    if (error) {
      console.error('Error while closing HTTP server', error);
    }

    await pool.end().catch((poolError) => {
      console.error('Error while closing PostgreSQL pool', poolError);
    });

    clearTimeout(forceExitTimer);
    process.exit(error ? 1 : 0);
  });
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
