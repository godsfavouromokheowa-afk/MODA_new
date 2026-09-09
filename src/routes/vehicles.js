const express = require('express');
const { pool } = require('../config/database');
const { requireAuth, requireApprovedDriver } = require('../middleware/auth');
const { requirePositiveIntegerParam } = require('../middleware/validation');

const router = express.Router();

router.use(requireAuth, requireApprovedDriver);

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