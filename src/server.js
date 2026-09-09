const app = require('./app');
const env = require('./config/env');
const { pool, verifyDatabaseConnection } = require('./config/database');

async function startServer() {
  try {
    await verifyDatabaseConnection();

    const server = app.listen(env.port, () => {
      console.log(`MODA API listening on port ${env.port}`);
    });

    const shutdown = async (signal) => {
      console.log(`${signal} received. Shutting down gracefully.`);
      server.close(async () => {
        await pool.end();
        process.exit(0);
      });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error) {
    console.error('Unable to start MODA API:', error);
    await pool.end();
    process.exitCode = 1;
  }
}

startServer();
