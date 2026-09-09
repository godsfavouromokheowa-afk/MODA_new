const express = require('express');
const { pool } = require('../config/database');

const router = express.Router();

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
