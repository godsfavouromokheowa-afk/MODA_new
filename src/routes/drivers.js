// Driver self-service: profile, assigned rides, availability, and GPS location.
// Anyone logged in can submit a driver application; every route below that
// line requires an approved driver, so demoted or pending drivers are cut off.
const express = require('express');
const { pool } = require('../config/database');
const { requireAuth, requireApprovedDriver } = require('../middleware/auth');

const router = express.Router();

// Logged-in rider: submits a driver application for review. Only rider
// accounts qualify — drivers and admins get a 409.
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

// Approved driver: returns their own availability and last known location.
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

// Approved driver: lists every ride ever assigned to them, newest first,
// including fare and whether the rider confirmed it.
router.get('/me/rides', async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT id, rider_id, vehicle_id, pickup_location, dropoff_location,
              pickup_latitude, pickup_longitude, status, distance_km,
              price_per_km, fare, fare_confirmed_by_rider, currency, requested_at, accepted_at, completed_at
       FROM rides WHERE driver_id = $1 ORDER BY requested_at DESC`,
      [request.user.sub]
    );

    return response.json({ rides: result.rows });
  } catch (error) {
    return next(error);
  }
});

// Approved driver: switches between offline, available, and busy. Refuses to
// go 'available' mid-trip with a 409, so a driver on an accepted or active
// ride can't be matched to a second one. Going offline mid-trip stays allowed.
router.patch('/me/availability', async (request, response, next) => {
  const { availability } = request.body;

  if (!['offline', 'available', 'busy'].includes(availability)) {
    return response.status(400).json({ error: 'Availability must be offline, available, or busy.' });
  }

  // Lock order: users then rides.
  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // Lock the driver row first (before any ride rows) so concurrent accept /
    // match / availability requests can't deadlock against each other.
    await client.query(
      `SELECT id FROM users WHERE id = $1 FOR UPDATE`,
      [request.user.sub]
    );

    // Rejects flipping back to 'available' while an active ride exists. The
    // lock above makes this check race-safe within the transaction.
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
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    return next(error);
  } finally {
    if (client) client.release();
  }
});

// Approved driver: reports GPS coordinates. Validates ranges and stamps when
// the fix was recorded — dispatch matching only trusts recent locations.
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