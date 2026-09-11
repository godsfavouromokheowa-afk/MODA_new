const express = require('express');
const { pool } = require('../config/database');
const { requireAuth, requireApprovedDriver } = require('../middleware/auth');

const router = express.Router();

router.post('/apply', requireAuth, async (request, response, next) => {
  try {
    const result = await pool.query(
      `UPDATE users
       SET driver_application_status = 'pending', driver_application_submitted_at = NOW(),
           driver_application_reviewed_at = NULL
       WHERE id = $1 AND role = 'rider'
       RETURNING id, name, email, role, driver_application_status, driver_application_submitted_at`,
      [request.user.sub]
    );

    if (result.rowCount === 0) {
      return response.status(409).json({ error: 'Only rider accounts can submit a driver application.' });
    }

    return response.status(202).json({ application: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.use(requireAuth, requireApprovedDriver);

router.get('/me', async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, role, availability, latitude, longitude, location_updated_at
       FROM users WHERE id = $1`,
      [request.user.sub]
    );

    return response.json({ driver: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.get('/me/rides', async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT id, rider_id, vehicle_id, pickup_location, dropoff_location,
              pickup_latitude, pickup_longitude, status, distance_km,
              price_per_km, fare, currency, requested_at, accepted_at, completed_at
       FROM rides WHERE driver_id = $1 ORDER BY requested_at DESC`,
      [request.user.sub]
    );

    return response.json({ rides: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.patch('/me/availability', async (request, response, next) => {
  const { availability } = request.body;

  if (!['offline', 'available', 'busy'].includes(availability)) {
    return response.status(400).json({ error: 'Availability must be offline, available, or busy.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT id FROM users WHERE id = $1 FOR UPDATE`,
      [request.user.sub]
    );

    if (availability === 'available') {
      const activeRide = await client.query(
        `SELECT 1 FROM rides WHERE driver_id = $1 AND status IN ('accepted', 'in_progress') FOR UPDATE`,
        [request.user.sub]
      );

      if (activeRide.rowCount > 0) {
        await client.query('ROLLBACK');
        return response.status(409).json({ error: 'Driver already has an active ride.' });
      }
    }

    const result = await client.query(
      `UPDATE users SET availability = $1
       WHERE id = $2
       RETURNING id, name, email, role, availability, latitude, longitude, location_updated_at`,
      [availability, request.user.sub]
    );

    await client.query('COMMIT');

    return response.json({ driver: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    return next(error);
  } finally {
    client.release();
  }
});

router.patch('/me/location', async (request, response, next) => {
  const { latitude, longitude } = request.body;

  if (
    typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
    typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
  ) {
    return response.status(400).json({ error: 'Valid latitude and longitude are required.' });
  }

  try {
    const result = await pool.query(
      `UPDATE users SET latitude = $1, longitude = $2, location_updated_at = NOW()
       WHERE id = $3
       RETURNING id, name, email, role, availability, latitude, longitude, location_updated_at`,
      [latitude, longitude, request.user.sub]
    );

    return response.json({ driver: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;