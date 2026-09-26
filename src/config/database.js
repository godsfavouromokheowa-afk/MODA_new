// Database setup: creates the shared PostgreSQL connection pool used by every
// route, plus a startup health check so the server only boots when the
// database is reachable.
const fs = require('node:fs');
const { Pool } = require('pg');
const env = require('./env');

function sslConfig() {
  if (!env.databaseSsl) {
    return undefined;
  }

  const ssl = {
    rejectUnauthorized: env.databaseSslRejectUnauthorized
  };

  if (env.databaseSslCa) {
    ssl.ca = env.databaseSslCa.includes('BEGIN CERTIFICATE')
      ? env.databaseSslCa
      : fs.readFileSync(env.databaseSslCa, 'utf8');
  }

  return ssl;
}

const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: sslConfig()
});

// Verifies the database is reachable at startup. Borrows one pooled
// connection, runs a trivial query, and always returns the connection.
async function verifyDatabaseConnection() {
  const client = await pool.connect();

  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  verifyDatabaseConnection
};
