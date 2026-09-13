// Vehicle management: lets approved drivers register and maintain the cars
// they drive with. Every route here requires an approved driver and only ever
// touches the caller's own vehicles.
const express = require('express');
const { pool } = require('../config/database');
const { requireAuth, requireApprovedDriver } = require('../middleware/auth');
const { requirePositiveIntegerParam } = require('../middleware/validation');

const router = express.Router();

router.use(requireAuth, requireApprovedDriver);

// Approved driver: registers a vehicle. Plates are uppercased and globally
// unique — a duplicate plate returns 409.
router.post('/', async (request, response, next) => {
  const { make, model, licensePlate } = request.body;

  if (
    typeof make !== 'string' || !make.trim() ||
    typeof model !== 'string' || !model.trim() ||
    typeof licensePlate !== 'string' || !licensePlate.trim()
  ) {
    return response.status(400).json({ error: 'Make, model, and license plate are required.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO vehicles (driver_id, make, model, license_plate)
       VALUES ($1, $2, $3, $4)
       RETURNING id, driver_id, make, model, license_plate, status, created_at`,
      [request.user.sub, make.trim(), model.trim(), licensePlate.trim().toUpperCase()]
    );

    return response.status(201).json({ vehicle: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return response.status(409).json({ error: 'That license plate is already registered.' });
    }
    return next(error);
  }
});

// Approved driver: lists their own vehicles, newest first.
router.get('/', async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT id, driver_id, make, model, license_plate, status, created_at
       FROM vehicles WHERE driver_id = $1 ORDER BY created_at DESC`,
      [request.user.sub]
    );

    return response.json({ vehicles: result.rows });
  } catch (error) {
    return next(error);
  }
});

// Approved driver: activates or deactivates one of their vehicles. Only an
// active vehicle can accept or be assigned rides.
router.patch('/:id/status', requirePositiveIntegerParam('id'), async (request, response, next) => {
  const { status } = request.body;

  if (!['active', 'inactive'].includes(status)) {
    return response.status(400).json({ error: 'Status must be active or inactive.' });
  }

  try {
    const result = await pool.query(
      `UPDATE vehicles SET status = $1
       WHERE id = $2 AND driver_id = $3
       RETURNING id, driver_id, make, model, license_plate, status, created_at`,
      [status, request.params.id, request.user.sub]
    );

    if (result.rowCount === 0) {
      return response.status(404).json({ error: 'Vehicle not found.' });
    }

    return response.json({ vehicle: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

// Approved driver: edits a vehicle's details. Like registration, a plate
// taken by another vehicle returns 409.
router.patch('/:id', requirePositiveIntegerParam('id'), async (request, response, next) => {
  const { make, model, licensePlate } = request.body;

  if (
    typeof make !== 'string' || !make.trim() ||
    typeof model !== 'string' || !model.trim() ||
    typeof licensePlate !== 'string' || !licensePlate.trim()
  ) {
    return response.status(400).json({ error: 'Make, model, and license plate are required.' });
  }

  try {
    const result = await pool.query(
      `UPDATE vehicles SET make = $1, model = $2, license_plate = $3
       WHERE id = $4 AND driver_id = $5
       RETURNING id, driver_id, make, model, license_plate, status, created_at`,
      [make.trim(), model.trim(), licensePlate.trim().toUpperCase(), request.params.id, request.user.sub]
    );

    if (result.rowCount === 0) {
      return response.status(404).json({ error: 'Vehicle not found.' });
    }

    return response.json({ vehicle: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return response.status(409).json({ error: 'That license plate is already registered.' });
    }
    return next(error);
  }
});

// Approved driver: deletes a vehicle that has never been used by a ride.
// Vehicles with ride history are kept (409) so past trips still reference a car.
router.delete('/:id', requirePositiveIntegerParam('id'), async (request, response, next) => {
  try {
    const result = await pool.query(
      `DELETE FROM vehicles
       WHERE id = $1 AND driver_id = $2
         AND NOT EXISTS (SELECT 1 FROM rides WHERE rides.vehicle_id = vehicles.id)
       RETURNING id`,
      [request.params.id, request.user.sub]
    );

    if (result.rowCount === 0) {
      const vehicle = await pool.query(
        'SELECT 1 FROM vehicles WHERE id = $1 AND driver_id = $2',
        [request.params.id, request.user.sub]
      );

      if (vehicle.rowCount === 0) {
        return response.status(404).json({ error: 'Vehicle not found.' });
      }

      return response.status(409).json({ error: 'Vehicles used by rides cannot be deleted.' });
    }

    return response.status(204).send();
  } catch (error) {
    return next(error);
  }
});

module.exports = router;