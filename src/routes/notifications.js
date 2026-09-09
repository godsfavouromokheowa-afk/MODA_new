const express = require('express');
const { pool } = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { requirePositiveIntegerParam } = require('../middleware/validation');

const router = express.Router();

router.use(requireAuth);

router.get('/', async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT id, type, title, message, data, read_at, created_at
       FROM notifications WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 100`,
      [request.user.sub]
    );

    return response.json({ notifications: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.patch('/:id/read', requirePositiveIntegerParam('id'), async (request, response, next) => {
  try {
    const result = await pool.query(
      `UPDATE notifications SET read_at = COALESCE(read_at, NOW())
       WHERE id = $1 AND user_id = $2
       RETURNING id, type, title, message, data, read_at, created_at`,
      [request.params.id, request.user.sub]
    );

    if (result.rowCount === 0) {
      return response.status(404).json({ error: 'Notification not found.' });
    }

    return response.json({ notification: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;