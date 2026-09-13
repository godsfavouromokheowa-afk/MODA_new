// Ride lifecycle: creation, acceptance, status moves, cancellation, fare
// confirmation, and pricing. Every route requires a logged-in user; the
// driver-only ones additionally require an approved driver, and the admin
// list additionally requires an admin.
const express = require('express');
const { pool } = require('../config/database');
const env = require('../config/env');
const { requireAuth, requireRole, requireApprovedDriver } = require('../middleware/auth');
const { requirePositiveIntegerParam } = require('../middleware/validation');
const { createNotification } = require('../services/notifications');

const router = express.Router();

router.use(requireAuth);

// Logged-in user (usually a rider): requests a ride. Coordinates are optional
// but validated when given, so dispatch matching can use them later.
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
         pickup_latitude, pickup_longitude, distance_km, price_per_km, fare, fare_confirmed_by_rider, currency, requested_at`,
      [request.user.sub, pickupLocation.trim(), dropoffLocation.trim(), pickupLatitude ?? null, pickupLongitude ?? null]
    );

    return response.status(201).json({ ride: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

// Rider: lists their own ride requests, newest first, with pickup pin and
// fare-confirmation state so the app can map and price each trip.
router.get('/', async (request, response, next) => {
  try {
    const result = await pool.query(
            `SELECT id, rider_id, driver_id, vehicle_id, pickup_location,
              dropoff_location, pickup_latitude, pickup_longitude, status, distance_km, price_per_km, fare, fare_confirmed_by_rider, currency,
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

// Rider: fetches one of their own rides by id. A ride belonging to someone
// else looks like a 404 so riders can't probe other people's trips.
router.get('/:id', requirePositiveIntegerParam('id'), async (request, response, next) => {
  try {
    const result = await pool.query(
            `SELECT id, rider_id, driver_id, vehicle_id, pickup_location,
              dropoff_location, pickup_latitude, pickup_longitude, status, distance_km, price_per_km, fare, fare_confirmed_by_rider, currency,
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

// Rider: cancels their own ride while it is still requested or accepted. Runs
// in a transaction so the ride row and the driver's freed availability update
// together; a driver who already went offline stays offline.
router.patch('/:id/cancel', requirePositiveIntegerParam('id'), async (request, response, next) => {
  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE rides
       SET status = 'cancelled', completed_at = NOW()
       WHERE id = $1 AND rider_id = $2 AND status IN ('requested', 'accepted')
       RETURNING id, rider_id, driver_id, vehicle_id, pickup_location, dropoff_location,
                 pickup_latitude, pickup_longitude, status, distance_km, price_per_km, fare, fare_confirmed_by_rider, currency,
                 requested_at, accepted_at, completed_at`,
      [request.params.id, request.user.sub]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'Only requested or accepted rides can be cancelled.' });
    }

    // Free the driver only when they are still marked busy, preserving a
    // manual switch to offline made mid-ride.
    if (result.rows[0].driver_id) {
      await client.query(
        `UPDATE users SET availability = 'available'
         WHERE id = $1 AND availability = 'busy'`,
        [result.rows[0].driver_id]
      );
    }

    await client.query('COMMIT');

    // Notify after COMMIT so a notification failure only logs instead of
    // turning an already-cancelled ride into a 500.
    if (result.rows[0].driver_id) {
      try {
        await createNotification({
          userId: result.rows[0].driver_id,
          type: 'ride_cancelled',
          title: 'Ride cancelled',
          message: 'The rider cancelled the ride request.',
          data: { rideId: result.rows[0].id }
        });
      } catch (notificationError) {
        console.error('Failed to create ride_cancelled notification:', notificationError);
      }
    }

    return response.json({ ride: result.rows[0] });
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    return next(error);
  } finally {
    if (client) client.release();
  }
});

// Approved driver: browses every unassigned ride request, oldest first, to
// pick one to accept.
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

// Approved driver: accepts a requested ride with one of their active vehicles.
// Rejects with 409 when the driver already has an active ride (see the unique
// index in migration 012 for the database-level backstop) and flips the driver
// to busy in the same transaction.
router.patch('/:id/accept', requirePositiveIntegerParam('id'), requireApprovedDriver, async (request, response, next) => {
  const { vehicleId } = request.body;
  const vehicleIdNumber = Number(vehicleId);

  if (!Number.isSafeInteger(vehicleIdNumber) || vehicleIdNumber < 1) {
    return response.status(400).json({ error: 'A valid vehicleId is required.' });
  }

  // Lock order: users then rides.
  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // Lock the driver row first (before any ride rows) so concurrent accept /
    // match / availability requests all take locks in the same order and can't
    // deadlock.
    await client.query(
      `SELECT id FROM users WHERE id = $1 FOR UPDATE`,
      [request.user.sub]
    );
    // Rejects double-booking inside the same transaction, so two simultaneous
    // accept requests can't both slip through.
    const activeRide = await client.query(
      `SELECT 1 FROM rides WHERE driver_id = $1 AND status IN ('accepted', 'in_progress') FOR UPDATE`,
      [request.user.sub]
    );

    if (activeRide.rowCount > 0) {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'Driver already has an active ride.' });
    }

    // The vehicle must be active and owned by the accepting driver.
    const vehicle = await client.query(
      `SELECT 1 FROM vehicles WHERE id = $1 AND driver_id = $2 AND status = 'active' FOR UPDATE`,
      [vehicleIdNumber, request.user.sub]
    );

    if (vehicle.rowCount === 0) {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'Vehicle is not active and owned by you.' });
    }

    // Claim the ride only if it is still requested, so two drivers racing the
    // same request can't both win it.
    const result = await client.query(
      `UPDATE rides SET driver_id = $1, vehicle_id = $2, status = 'accepted', accepted_at = NOW()
       WHERE id = $3 AND status = 'requested'
       RETURNING id, rider_id, driver_id, vehicle_id, pickup_location, dropoff_location,
                 pickup_latitude, pickup_longitude, status, fare, fare_confirmed_by_rider, requested_at, accepted_at`,
      [request.user.sub, vehicleIdNumber, request.params.id]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'Ride is unavailable or vehicle is not active and owned by you.' });
    }

    // The driver goes busy in the same transaction as the ride claim, keeping
    // availability and real ride state in sync.
    await client.query(
      `UPDATE users SET availability = 'busy' WHERE id = $1`,
      [request.user.sub]
    );
    await client.query('COMMIT');

    // Notify after COMMIT so a notification failure only logs instead of
    // turning an already-accepted ride into a 500.
    try {
      await createNotification({
        userId: result.rows[0].rider_id,
        type: 'ride_accepted',
        title: 'Driver assigned',
        message: 'A driver has accepted your ride.',
        data: { rideId: result.rows[0].id, driverId: result.rows[0].driver_id, vehicleId: result.rows[0].vehicle_id }
      });
    } catch (notificationError) {
      console.error('Failed to create ride_accepted notification:', notificationError);
    }

    return response.json({ ride: result.rows[0] });
  } catch (error) {
    // Maps a leaked unique-index violation to the same friendly 409 clients
    // already get from the explicit active-ride check above.
    if (error && error.code === '23505') {
      if (client) {
        try { await client.query('ROLLBACK'); } catch (_) {}
      }
      return response.status(409).json({ error: 'Driver already has an active ride.' });
    }
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    return next(error);
  } finally {
    if (client) client.release();
  }
});

// Approved driver: moves their own ride along accepted -> in_progress ->
// completed (or cancels it). Completing requires a priced fare the rider
// already confirmed; finishing a trip frees the driver unless they went
// offline mid-ride.
router.patch('/:id/status', requirePositiveIntegerParam('id'), requireApprovedDriver, async (request, response, next) => {
  const { status } = request.body;

  if (!['in_progress', 'completed', 'cancelled'].includes(status)) {
    return response.status(400).json({ error: 'Status must be in_progress, completed, or cancelled.' });
  }

  // Lock order: users then rides.
  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // Lock the ride row so the transition check and update below are atomic.
    const current = await client.query(
      `SELECT id, fare, fare_confirmed_by_rider, status
       FROM rides WHERE id = $1 AND driver_id = $2 FOR UPDATE`,
      [request.params.id, request.user.sub]
    );

    if (current.rowCount === 0) {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'Ride cannot transition to that status.' });
    }

    const currentRide = current.rows[0];
    // Only forward moves along the ride state machine are allowed — no skips
    // or backwards jumps.
    const transitionOk =
      (currentRide.status === 'accepted' && ['in_progress', 'cancelled'].includes(status)) ||
      (currentRide.status === 'in_progress' && ['completed', 'cancelled'].includes(status));

    if (!transitionOk) {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'Ride cannot transition to that status.' });
    }

    // A trip can't complete until the rider has seen and confirmed the price.
    if (status === 'completed' && (currentRide.fare === null || !currentRide.fare_confirmed_by_rider)) {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'Rider has not confirmed the fare.' });
    }

    // Re-checks the state machine inside the UPDATE itself so a concurrent
    // change can't sneak a stale transition through.
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
                 pickup_latitude, pickup_longitude, status, fare, fare_confirmed_by_rider, requested_at, accepted_at, completed_at`,
      [status, request.params.id, request.user.sub]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'Ride cannot transition to that status.' });
    }

    // Free the driver on completion or cancellation, unless they already went
    // offline mid-ride — that choice is preserved.
    if (['completed', 'cancelled'].includes(status)) {
      await client.query(
        `UPDATE users SET availability = 'available'
         WHERE id = $1 AND availability = 'busy'`,
        [result.rows[0].driver_id]
      );
    }

    await client.query('COMMIT');

    // Notify after COMMIT so a notification failure only logs instead of
    // turning an already-moved ride into a 500.
    try {
      await createNotification({
        userId: result.rows[0].rider_id,
        type: `ride_${status}`,
        title: `Ride ${status.replace('_', ' ')}`,
        message: `Your ride is now ${status.replace('_', ' ')}.`,
        data: { rideId: result.rows[0].id, status }
      });
    } catch (notificationError) {
      console.error('Failed to create ride status notification:', notificationError);
    }

    return response.json({ ride: result.rows[0] });
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    return next(error);
  } finally {
    if (client) client.release();
  }
});

// Rider: confirms the driver-set fare on their own accepted or in-progress
// ride. The update only matches a priced active ride, so anything else is a
// 409 — no separate lookup needed.
router.patch('/:id/confirm-fare', requirePositiveIntegerParam('id'), async (request, response, next) => {
  try {
    const result = await pool.query(
      `UPDATE rides
       SET fare_confirmed_by_rider = true
       WHERE id = $1 AND rider_id = $2
         AND status IN ('accepted', 'in_progress')
         AND fare IS NOT NULL
       RETURNING id, rider_id, driver_id, vehicle_id, pickup_location, dropoff_location,
                 pickup_latitude, pickup_longitude, status, distance_km, price_per_km,
                 fare, fare_confirmed_by_rider, currency, requested_at, accepted_at`,
      [request.params.id, request.user.sub]
    );

    if (result.rowCount === 0) {
      return response.status(409).json({ error: 'Fare cannot be confirmed for this ride.' });
    }

    return response.json({ ride: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

// Approved driver: prices their own accepted or active ride. Pricing is
// one-shot (immutable once set) and capped by the configured per-km maximum.
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

  // Round inputs to kobo before the math, then fare = max(minimum, base +
  // distance x per-km) rounded again to kobo.
  const roundedDistance = Math.round(distanceKm * 100) / 100;
  const roundedPricePerKm = Math.round(pricePerKm * 100) / 100;
  const distanceFare = env.baseFareNgn + roundedDistance * roundedPricePerKm;
  const fare = Math.round(Math.max(env.minimumFareNgn, distanceFare) * 100) / 100;

  try {
    // The NULL guards make pricing one-shot: a priced ride matches zero rows
    // and returns 409 instead of silently repricing.
    const result = await pool.query(
      `UPDATE rides
       SET distance_km = $1, price_per_km = $2, fare = $3, currency = 'NGN'
       WHERE id = $4 AND driver_id = $5 AND status IN ('accepted', 'in_progress')
         AND distance_km IS NULL AND price_per_km IS NULL AND fare IS NULL
       RETURNING id, rider_id, driver_id, vehicle_id, pickup_location, dropoff_location,
                 pickup_latitude, pickup_longitude, status, distance_km, price_per_km, fare, fare_confirmed_by_rider, currency, requested_at, accepted_at`,
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