const { pool } = require('../config/database');

async function createNotification({ userId, type, title, message, data = {} }) {
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, message, data)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [userId, type, title, message, JSON.stringify(data)]
  );
}

module.exports = { createNotification };