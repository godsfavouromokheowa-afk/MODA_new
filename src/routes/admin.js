const express = require('express');
const { pool } = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requirePositiveIntegerParam } = require('../middleware/validation');
const { createNotification } = require('../services/notifications');

const router = express.Router();

router.use(requireAuth, requireRole('admin'));

router.get('/users', async (_request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, role, driver_application_status,
              driver_application_submitted_at, driver_application_reviewed_at, created_at
       FROM users ORDER BY created_at DESC`
    );

    return response.json({ users: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.patch('/users/:id/role', requirePositiveIntegerParam('id'), async (request, response, next) => {
  const { role } = request.body;
  const targetUserId = request.params.id;

  if (!['rider', 'driver', 'admin'].includes(role)) {
    return response.status(400).json({ error: 'Role must be rider, driver, or admin.' });
  }

  if (String(request.user.sub) === targetUserId && role !== 'admin') {
    return response.status(409).json({ error: 'An admin cannot demote their own account.' });
  }

  try {
    const currentUser = await pool.query(
      'SELECT role FROM users WHERE id = $1',
      [targetUserId]
    );

    if (currentUser.rowCount === 0) {
      return response.status(404).json({ error: 'User not found.' });
    }

    if (currentUser.rows[0].role === 'admin' && role !== 'admin') {
      const adminCount = await pool.query("SELECT COUNT(*) FROM users WHERE role = 'admin'");

      if (Number(adminCount.rows[0].count) <= 1) {
        return response.status(409).json({ error: 'The final admin account cannot be demoted.' });
      }
    }

    const result = await pool.query(
      `UPDATE users
       SET role = $1,
           role_changed_at = CASE WHEN role IS DISTINCT FROM $1 THEN NOW() ELSE role_changed_at END
       WHERE id = $2
       RETURNING id, name, email, role, role_changed_at, created_at`,
      [role, targetUserId]
    );

    if (currentUser.rows[0].role !== role) {
      await createNotification({
        userId: result.rows[0].id,
        type: 'role_changed',
        title: 'Account role updated',
        message: `Your account role is now ${role}.`,
        data: { userId: result.rows[0].id, role }
      });
    }

    return response.json({ user: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.get('/driver-applications', async (_request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, driver_application_status,
              driver_application_submitted_at, driver_application_reviewed_at
       FROM users
       WHERE driver_application_status IN ('pending', 'approved', 'rejected')
       ORDER BY driver_application_submitted_at DESC NULLS LAST`
    );

    return response.json({ applications: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.patch('/driver-applications/:id', requirePositiveIntegerParam('id'), async (request, response, next) => {
  const { status } = request.body;

  if (!['approved', 'rejected'].includes(status)) {
    return response.status(400).json({ error: 'Status must be approved or rejected.' });
  }

  try {
    const result = await pool.query(
      `UPDATE users
       SET driver_application_status = $1,
           driver_application_reviewed_at = NOW(),
           role = CASE WHEN $1 = 'approved' THEN 'driver' ELSE 'rider' END
       WHERE id = $2 AND driver_application_status = 'pending'
       RETURNING id, name, email, role, driver_application_status,
                 driver_application_submitted_at, driver_application_reviewed_at`,
      [status, request.params.id]
    );

    if (result.rowCount === 0) {
      return response.status(409).json({ error: 'A pending driver application was not found.' });
    }

    await createNotification({
      userId: result.rows[0].id,
      type: `driver_application_${status}`,
      title: `Driver application ${status}`,
      message: `Your driver application has been ${status}.`,
      data: { userId: result.rows[0].id, status }
    });

    return response.json({ application: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.get('/rides', async (request, response, next) => {
  const status = request.query.status;
  const validStatuses = ['requested', 'accepted', 'in_progress', 'completed', 'cancelled'];

  if (status && !validStatuses.includes(status)) {
    return response.status(400).json({ error: 'Invalid ride status filter.' });
  }

  try {
    const result = await pool.query(
      `SELECT rides.id, rides.rider_id, riders.name AS rider_name,
              rides.driver_id, drivers.name AS driver_name, rides.vehicle_id,
              rides.pickup_location, rides.dropoff_location, rides.status,
              rides.distance_km, rides.price_per_km, rides.fare, rides.currency,
              rides.requested_at, rides.accepted_at, rides.completed_at
       FROM rides
       JOIN users AS riders ON riders.id = rides.rider_id
       LEFT JOIN users AS drivers ON drivers.id = rides.driver_id
       WHERE ($1::text IS NULL OR rides.status = $1)
       ORDER BY rides.requested_at DESC`,
      [status || null]
    );

    return response.json({ rides: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.patch('/rides/:id/assign', requirePositiveIntegerParam('id'), async (request, response, next) => {
  const { driverId, vehicleId } = request.body;
  const driverIdNumber = Number(driverId);
  const vehicleIdNumber = Number(vehicleId);

  if (
    !Number.isSafeInteger(driverIdNumber) || !Number.isSafeInteger(vehicleIdNumber) ||
    driverIdNumber < 1 || vehicleIdNumber < 1
  ) {
    return response.status(400).json({ error: 'Valid driverId and vehicleId are required.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT id FROM users WHERE id = $1 FOR UPDATE`,
      [driverIdNumber]
    );
    const activeRide = await client.query(
      `SELECT 1 FROM rides WHERE driver_id = $1 AND status IN ('accepted', 'in_progress') FOR UPDATE`,
      [driverIdNumber]
    );

    if (activeRide.rowCount > 0) {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'Driver already has an active ride.' });
    }

    const result = await client.query(
      `UPDATE rides AS rides
       SET driver_id = $1, vehicle_id = $2, status = 'accepted', accepted_at = NOW()
       WHERE rides.id = $3 AND rides.status = 'requested'
         AND EXISTS (
           SELECT 1 FROM users WHERE users.id = $1 AND users.role = 'driver'
         )
         AND EXISTS (
           SELECT 1 FROM vehicles
           WHERE vehicles.id = $2 AND vehicles.driver_id = $1 AND vehicles.status = 'active'
         )
       RETURNING rides.id, rides.rider_id, rides.driver_id, rides.vehicle_id,
                 rides.pickup_location, rides.dropoff_location, rides.status,
                 rides.fare, rides.requested_at, rides.accepted_at`,
      [driverIdNumber, vehicleIdNumber, request.params.id]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'Ride is unavailable or driver and vehicle do not match.' });
    }

    await client.query(
      `UPDATE users SET availability = 'busy' WHERE id = $1`,
      [driverIdNumber]
    );
    await client.query('COMMIT');

    return response.json({ ride: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    return next(error);
  } finally {
    client.release();
  }
});

router.post('/rides/:id/match', requirePositiveIntegerParam('id'), async (request, response, next) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const ride = await client.query(
      `SELECT id, pickup_latitude, pickup_longitude
       FROM rides WHERE id = $1 AND status = 'requested' FOR UPDATE`,
      [request.params.id]
    );

    if (ride.rowCount === 0) {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'Ride is unavailable for matching.' });
    }

    if (ride.rows[0].pickup_latitude === null || ride.rows[0].pickup_longitude === null) {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'Ride pickup coordinates are required for matching.' });
    }

    const driver = await client.query(
      `SELECT users.id AS driver_id, vehicles.id AS vehicle_id,
              (
                111.32 * SQRT(
                  POWER(users.latitude - $1, 2) +
                  POWER((users.longitude - $2) * COS(RADIANS($1)), 2)
                )
              ) AS distance_km
       FROM users
       JOIN vehicles ON vehicles.driver_id = users.id AND vehicles.status = 'active'
       WHERE users.role = 'driver'
         AND users.availability = 'available'
           AND NOT EXISTS (
             SELECT 1 FROM rides active_rides
             WHERE active_rides.driver_id = users.id
               AND active_rides.status IN ('accepted', 'in_progress')
           )
         AND users.latitude IS NOT NULL
         AND users.longitude IS NOT NULL
         AND users.location_updated_at >= NOW() - INTERVAL '15 minutes'
       ORDER BY distance_km ASC, users.id ASC
       LIMIT 1
       FOR UPDATE OF users, vehicles`,
      [ride.rows[0].pickup_latitude, ride.rows[0].pickup_longitude]
    );

    if (driver.rowCount === 0) {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'No available driver with a recent location was found.' });
    }

    const activeRide = await client.query(
      `SELECT 1 FROM rides
       WHERE driver_id = $1 AND status IN ('accepted', 'in_progress')
       FOR UPDATE`,
      [driver.rows[0].driver_id]
    );

    if (activeRide.rowCount > 0) {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'Driver already has an active ride.' });
    }

    const assigned = await client.query(
      `UPDATE rides
       SET driver_id = $1, vehicle_id = $2, status = 'accepted', accepted_at = NOW()
       WHERE id = $3 AND status = 'requested'
       RETURNING id, rider_id, driver_id, vehicle_id, pickup_location, dropoff_location,
                 pickup_latitude, pickup_longitude, status, fare, requested_at, accepted_at`,
      [driver.rows[0].driver_id, driver.rows[0].vehicle_id, request.params.id]
    );

    await client.query(
      `UPDATE users SET availability = 'busy' WHERE id = $1`,
      [driver.rows[0].driver_id]
    );

    await client.query('COMMIT');
    return response.json({
      ride: assigned.rows[0],
      match: { driverId: driver.rows[0].driver_id, vehicleId: driver.rows[0].vehicle_id }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    return next(error);
  } finally {
    client.release();
  }
});

router.patch('/rides/:id/cancel', requirePositiveIntegerParam('id'), async (request, response, next) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE rides SET status = 'cancelled', completed_at = NOW()
       WHERE id = $1 AND status IN ('requested', 'accepted', 'in_progress')
       RETURNING id, rider_id, driver_id, vehicle_id, pickup_location, dropoff_location,
                 status, fare, requested_at, accepted_at, completed_at`,
      [request.params.id]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'Ride cannot be cancelled.' });
    }

    if (result.rows[0].driver_id) {
      await client.query(
        `UPDATE users SET availability = 'available'
         WHERE id = $1 AND availability = 'busy'`,
        [result.rows[0].driver_id]
      );
    }

    await client.query('COMMIT');

    await createNotification({
      userId: result.rows[0].rider_id,
      type: 'ride_cancelled',
      title: 'Ride cancelled by dispatch',
      message: 'An administrator cancelled your ride.',
      data: { rideId: result.rows[0].id }
    });

    if (result.rows[0].driver_id) {
      await createNotification({
        userId: result.rows[0].driver_id,
        type: 'ride_cancelled',
        title: 'Ride cancelled by dispatch',
        message: 'An administrator cancelled the assigned ride.',
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

module.exports = router;