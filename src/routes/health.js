// Health check: reports whether the API and its database are reachable.
// Public (no auth) so load balancers and uptime monitors can poll it.
const express = require('express');
const { pool } = require('../config/database');

const router = express.Router();

// Returns { status: 'ok', database: 'connected' }. A dead database flows to
// the error handler as a 500 instead of a false "ok".
router.get('/', async (_request, response, next) => {
  try {
    await pool.query('SELECT 1');
    response.json({
      status: 'ok',
      database: 'connected'
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
