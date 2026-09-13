const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requirePositiveIntegerParam } = require('../middleware/validation');

const router = express.Router();

router.use(requireAuth);

router.post('/rides/:id/intent', requirePositiveIntegerParam('id'), async (request, response, next) => {
  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const ride = await client.query(
      `SELECT id, rider_id, fare, currency, status
       FROM rides WHERE id = $1 AND rider_id = $2 FOR UPDATE`,
      [request.params.id, request.user.sub]
    );

    if (ride.rowCount === 0) {
      await client.query('ROLLBACK');
      return response.status(404).json({ error: 'Ride not found.' });
    }

    if (ride.rows[0].status !== 'completed' || ride.rows[0].fare === null) {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'Only completed rides with a fare can be paid.' });
    }

    const existing = await client.query(
      `SELECT id, status FROM payments WHERE ride_id = $1 FOR UPDATE`,
      [ride.rows[0].id]
    );

    if (existing.rowCount > 0 && existing.rows[0].status !== 'pending') {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'This ride already has a settled payment.' });
    }

    const payment = await client.query(
      `INSERT INTO payments (ride_id, rider_id, amount, currency, provider, provider_reference)
       VALUES ($1, $2, $3, 'NGN', 'unconfigured', $4)
       ON CONFLICT (ride_id) DO UPDATE SET updated_at = NOW()
       RETURNING id, ride_id, rider_id, amount, currency, status, provider,
                 provider_reference, created_at, updated_at`,
      [ride.rows[0].id, ride.rows[0].rider_id, ride.rows[0].fare, `local_${crypto.randomUUID()}`]
    );

    await client.query('COMMIT');
    return response.status(201).json({ payment: payment.rows[0] });
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    return next(error);
  } finally {
    if (client) client.release();
  }
});

router.get('/:id', requirePositiveIntegerParam('id'), async (request, response, next) => {
  try {
    const result = await pool.query(
            `SELECT id, ride_id, rider_id, amount, currency, status, provider,
              provider_reference, confirmed_by_user_id, confirmed_at, created_at, updated_at
       FROM payments WHERE id = $1 AND rider_id = $2`,
      [request.params.id, request.user.sub]
    );

    if (result.rowCount === 0) {
      return response.status(404).json({ error: 'Payment not found.' });
    }

    return response.json({ payment: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.patch('/:id/mark-paid', requirePositiveIntegerParam('id'), requireRole('driver', 'admin'), async (request, response, next) => {
  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT payments.id, payments.status, rides.driver_id, rides.status AS ride_status
       FROM payments
       JOIN rides ON rides.id = payments.ride_id
       WHERE payments.id = $1
       FOR UPDATE OF payments, rides`,
      [request.params.id]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return response.status(404).json({ error: 'Payment not found.' });
    }

    const payment = result.rows[0];
    if (request.user.role === 'driver' && String(payment.driver_id) !== String(request.user.sub)) {
      await client.query('ROLLBACK');
      return response.status(403).json({ error: 'Only the assigned driver can confirm this cash payment.' });
    }

    if (payment.ride_status !== 'completed') {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'Cash payment can only be confirmed for a completed ride.' });
    }

    if (payment.status !== 'pending') {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'Only pending payments can be marked as paid.' });
    }

    const updated = await client.query(
      `UPDATE payments
       SET status = 'paid', provider = 'cash', confirmed_by_user_id = $1,
           confirmed_at = NOW(), updated_at = NOW()
       WHERE id = $2
       RETURNING id, ride_id, rider_id, amount, currency, status, provider,
                 provider_reference, confirmed_by_user_id, confirmed_at, created_at, updated_at`,
      [request.user.sub, request.params.id]
    );

    await client.query('COMMIT');
    return response.json({ payment: updated.rows[0] });
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    return next(error);
  } finally {
    if (client) client.release();
  }
});

module.exports = router;