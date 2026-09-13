// Database setup: creates the shared PostgreSQL connection pool used by every
// route, plus a startup health check so the server only boots when the
// database is reachable.
const { Pool } = require('pg');
const env = require('./env');

const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: env.databaseSsl ? { rejectUnauthorized: false } : undefined
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
