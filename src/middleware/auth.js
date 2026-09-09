const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { pool } = require('../config/database');

function requireAuth(request, response, next) {
  const authorization = request.get('authorization');
  const [scheme, token] = authorization ? authorization.split(' ') : [];

  if (scheme !== 'Bearer' || !token) {
    return response.status(401).json({ error: 'A valid bearer token is required.' });
  }

  try {
    request.user = jwt.verify(token, env.jwtSecret);
    return next();
  } catch (_error) {
    return response.status(401).json({ error: 'A valid bearer token is required.' });
  }
}

function requireRole(...roles) {
  return async (request, response, next) => {
    if (!roles.includes(request.user.role)) {
      return response.status(403).json({ error: 'You do not have permission to perform this action.' });
    }

    try {
      const result = await pool.query(
        `SELECT role, role_changed_at
         FROM users WHERE id = $1`,
        [request.user.sub]
      );
      const user = result.rows[0];
      const tokenIssuedAt = Number(request.user.iat || 0);
      const roleChangedAfterToken = user && user.role_changed_at > new Date((tokenIssuedAt + 1) * 1000);

      if (!user || user.role !== request.user.role || roleChangedAfterToken) {
        return response.status(403).json({ error: 'Your authorization is no longer valid. Please log in again.' });
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
}

async function requireApprovedDriver(request, response, next) {
  if (request.user.role !== 'driver') {
    return response.status(403).json({ error: 'You do not have permission to perform this action.' });
  }

  try {
    const result = await pool.query(
      'SELECT driver_application_status FROM users WHERE id = $1',
      [request.user.sub]
    );

    if (result.rowCount === 0 || result.rows[0].driver_application_status !== 'approved') {
      return response.status(403).json({ error: 'Driver approval is required for this action.' });
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = { requireAuth, requireRole, requireApprovedDriver };