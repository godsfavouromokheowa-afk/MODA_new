const { pool } = require('../src/config/database');

async function createFirstAdmin() {
  const email = process.argv[2]?.trim().toLowerCase();

  if (!email) {
    throw new Error('Usage: npm run bootstrap-admin -- user@example.com');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const admins = await client.query("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1");
    if (admins.rowCount > 0) {
      await client.query('ROLLBACK');
      throw new Error('An admin account already exists. Use the admin API to manage roles.');
    }

    const result = await client.query(
      `UPDATE users
       SET role = 'admin', role_changed_at = NOW()
       WHERE email = $1
       RETURNING id, name, email, role`,
      [email]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      throw new Error(`No user was found for ${email}. Register the user first.`);
    }

    await client.query('COMMIT');
    console.log(`Created first admin: ${result.rows[0].email}`);
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_rollbackError) {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

createFirstAdmin().catch((error) => {
  console.error(`Admin bootstrap failed: ${error.message}`);
  process.exitCode = 1;
});