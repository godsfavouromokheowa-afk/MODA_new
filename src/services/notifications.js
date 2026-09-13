// Notification service: writes an in-app notification row for a user. Callers
// invoke this after a ride or role change commits, wrapped so a notification
// failure never turns an already-successful change into a 500.
const { pool } = require('../config/database');

// Stores one notification. The payload object is stringified to JSONB so
// later SMS/push senders can read structured data (ride IDs, roles, etc.).
async function createNotification({ userId, type, title, message, data = {} }) {
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, message, data)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [userId, type, title, message, JSON.stringify(data)]
  );
}

module.exports = { createNotification };