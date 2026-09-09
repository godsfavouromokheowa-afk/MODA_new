const express = require('express');
const { pool } = require('../config/database');
const env = require('../config/env');
const { requireAuth, requireRole, requireApprovedDriver } = require('../middleware/auth');
const { requirePositiveIntegerParam } = require('../middleware/validation');
const { createNotification } = require('../services/notifications');

const router = express.Router();

router.use(requireAuth);

router.post('/', async (request, response, next) => {
  const { pickupLocation, dropoffLocation, pickupLatitude, pickupLongitude } = request.body;

  if (
    typeof pickupLocation !== 'string' || !pickupLocation.trim() ||
    typeof dropoffLocation !== 'string' || !dropoffLocation.trim() ||
    (pickupLatitude !== undefined &&
      (typeof pickupLatitude !== 'number' || !Number.isFinite(pickupLatitude) || pickupLatitude < -90 || pickupLatitude > 90)) ||
    (pickupLongitude !== undefined &&
      (typeof pickupLongitude !== 'number' || !Number.isFinite(pickupLongitude) || pickupLongitude < -180 || pickupLongitude > 180))
  ) {
    return response.status(400).json({
      error: 'Pickup and dropoff locations are required, with valid pickup coordinates when provided.'
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO rides (rider_id, pickup_location, dropoff_location, pickup_latitude, pickup_longitude)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, rider_id, pickup_location, dropoff_location, status,
         pickup_latitude, pickup_longitude, distance_km, price_per_km, fare, currency, requested_at`,
      [request.user.sub, pickupLocation.trim(), dropoffLocation.trim(), pickupLatitude ?? null, pickupLongitude ?? null]
    );

    return response.status(201).json({ ride: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.get('/', async (request, response, next) => {
  try {
    const result = await pool.query(
            `SELECT id, rider_id, driver_id, vehicle_id, pickup_location,
              dropoff_location, status, distance_km, price_per_km, fare, currency,
              requested_at, accepted_at, completed_at
       FROM rides
       WHERE rider_id = $1
       ORDER BY requested_at DESC`,
      [request.user.sub]
    );

    return response.json({ rides: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.get('/:id', requirePositiveIntegerParam('id'), async (request, response, next) => {
  try {
    const result = await pool.query(
            `SELECT id, rider_id, driver_id, vehicle_id, pickup_location,
              dropoff_location, status, distance_km, price_per_km, fare, currency,
              requested_at, accepted_at, completed_at
       FROM rides
       WHERE id = $1 AND rider_id = $2`,
      [request.params.id, request.user.sub]
    );

    if (result.rowCount === 0) {
      return response.status(404).json({ error: 'Ride not found.' });
    }

    return response.json({ ride: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.patch('/:id/cancel', requirePositiveIntegerParam('id'), async (request, response, next) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE rides
       SET status = 'cancelled', completed_at = NOW()
       WHERE id = $1 AND rider_id = $2 AND status IN ('requested', 'accepted')
       RETURNING id, rider_id, driver_id, vehicle_id, pickup_location, dropoff_location,
                 status, distance_km, price_per_km, fare, currency,
                 requested_at, accepted_at, completed_at`,
      [request.params.id, request.user.sub]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'Only requested or accepted rides can be cancelled.' });
    }

    if (result.rows[0].driver_id) {
      await client.query(
        `UPDATE users SET availability = 'available'
         WHERE id = $1 AND availability = 'busy'`,
        [result.rows[0].driver_id]
      );
    }

    await client.query('COMMIT');

    if (result.rows[0].driver_id) {
      await createNotification({
        userId: result.rows[0].driver_id,
        type: 'ride_cancelled',
        title: 'Ride cancelled',
        message: 'The rider cancelled the ride request.',
        data: { rideId: result.rows[0].id }
      });
    }

    return response.json({ ride: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    return next(error);
  } finally {
    client.release();
  }
});

router.get('/available/list', requireApprovedDriver, async (_request, response, next) => {
  try {
    const result = await pool.query(
            `SELECT id, rider_id, pickup_location, dropoff_location, status,
              distance_km, price_per_km, fare, currency, requested_at
       FROM rides WHERE status = 'requested' ORDER BY requested_at ASC`
    );

    return response.json({ rides: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.patch('/:id/accept', requirePositiveIntegerParam('id'), requireApprovedDriver, async (request, response, next) => {
  const { vehicleId } = request.body;
  const vehicleIdNumber = Number(vehicleId);

  if (!Number.isSafeInteger(vehicleIdNumber) || vehicleIdNumber < 1) {
    return response.status(400).json({ error: 'A valid vehicleId is required.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT id FROM users WHERE id = $1 FOR UPDATE`,
      [request.user.sub]
    );
    const activeRide = await client.query(
      `SELECT 1 FROM rides WHERE driver_id = $1 AND status IN ('accepted', 'in_progress') FOR UPDATE`,
      [request.user.sub]
    );

    if (activeRide.rowCount > 0) {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'Driver already has an active ride.' });
    }

    const vehicle = await client.query(
      `SELECT 1 FROM vehicles WHERE id = $1 AND driver_id = $2 AND status = 'active' FOR UPDATE`,
      [vehicleIdNumber, request.user.sub]
    );

    if (vehicle.rowCount === 0) {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'Vehicle is not active and owned by you.' });
    }

    const result = await client.query(
      `UPDATE rides SET driver_id = $1, vehicle_id = $2, status = 'accepted', accepted_at = NOW()
       WHERE id = $3 AND status = 'requested'
       RETURNING id, rider_id, driver_id, vehicle_id, pickup_location, dropoff_location,
                 status, fare, requested_at, accepted_at`,
      [request.user.sub, vehicleIdNumber, request.params.id]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'Ride is unavailable or vehicle is not active and owned by you.' });
    }

    await client.query(
      `UPDATE users SET availability = 'busy' WHERE id = $1`,
      [request.user.sub]
    );
    await client.query('COMMIT');

    await createNotification({
      userId: result.rows[0].rider_id,
      type: 'ride_accepted',
      title: 'Driver assigned',
      message: 'A driver has accepted your ride.',
      data: { rideId: result.rows[0].id, driverId: result.rows[0].driver_id, vehicleId: result.rows[0].vehicle_id }
    });

    return response.json({ ride: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    return next(error);
  } finally {
    client.release();
  }
});

router.patch('/:id/status', requirePositiveIntegerParam('id'), requireApprovedDriver, async (request, response, next) => {
  const { status } = request.body;

  if (!['in_progress', 'completed', 'cancelled'].includes(status)) {
    return response.status(400).json({ error: 'Status must be in_progress, completed, or cancelled.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE rides
       SET status = $1,
           completed_at = CASE WHEN $1 IN ('completed', 'cancelled') THEN NOW() ELSE completed_at END
       WHERE id = $2 AND driver_id = $3
         AND (
           (status = 'accepted' AND $1 IN ('in_progress', 'cancelled')) OR
           (status = 'in_progress' AND $1 IN ('completed', 'cancelled'))
         )
       RETURNING id, rider_id, driver_id, vehicle_id, pickup_location, dropoff_location,
                 status, fare, requested_at, accepted_at, completed_at`,
      [status, request.params.id, request.user.sub]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'Ride cannot transition to that status.' });
    }

    if (['completed', 'cancelled'].includes(status)) {
      await client.query(
        `UPDATE users SET availability = 'available'
         WHERE id = $1 AND availability = 'busy'`,
        [result.rows[0].driver_id]
      );
    }

    await client.query('COMMIT');

    await createNotification({
      userId: result.rows[0].rider_id,
      type: `ride_${status}`,
      title: `Ride ${status.replace('_', ' ')}`,
      message: `Your ride is now ${status.replace('_', ' ')}.`,
      data: { rideId: result.rows[0].id, status }
    });

    return response.json({ ride: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    return next(error);
  } finally {
    client.release();
  }
});

router.patch('/:id/pricing', requirePositiveIntegerParam('id'), requireApprovedDriver, async (request, response, next) => {
  const { distanceKm, pricePerKm } = request.body;

  if (
    typeof distanceKm !== 'number' || !Number.isFinite(distanceKm) || distanceKm <= 0 ||
    typeof pricePerKm !== 'number' || !Number.isFinite(pricePerKm) ||
    pricePerKm < 0 || pricePerKm > env.maxPricePerKmNgn
  ) {
    return response.status(400).json({
      error: `distanceKm must be greater than 0 and pricePerKm must be between 0 and ${env.maxPricePerKmNgn} NGN.`
    });
  }

  const roundedDistance = Math.round(distanceKm * 100) / 100;
  const roundedPricePerKm = Math.round(pricePerKm * 100) / 100;
  const distanceFare = env.baseFareNgn + roundedDistance * roundedPricePerKm;
  const fare = Math.round(Math.max(env.minimumFareNgn, distanceFare) * 100) / 100;

  try {
    const result = await pool.query(
      `UPDATE rides
       SET distance_km = $1, price_per_km = $2, fare = $3, currency = 'NGN'
       WHERE id = $4 AND driver_id = $5 AND status IN ('accepted', 'in_progress')
         AND distance_km IS NULL AND price_per_km IS NULL AND fare IS NULL
       RETURNING id, rider_id, driver_id, vehicle_id, pickup_location, dropoff_location,
                 status, distance_km, price_per_km, fare, currency, requested_at, accepted_at`,
      [roundedDistance, roundedPricePerKm, fare, request.params.id, request.user.sub]
    );

    if (result.rowCount === 0) {
      return response.status(409).json({ error: 'Only your accepted or active rides can be priced.' });
    }

    return response.json({ ride: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;