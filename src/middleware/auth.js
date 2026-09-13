// Authentication and authorization middleware: verifies JWTs, checks them
// against the live user row (role, approval, token version), and gates
// admin-only and approved-driver-only routes.
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { pool } = require('../config/database');

// Reads the current user row so token claims are never trusted on their own.
// A deleted user returns null so the caller can reject the token.
async function loadLiveUser(userId) {
  const result = await pool.query(
    `SELECT role, role_changed_at, driver_application_status, token_version
     FROM users WHERE id = $1`,
    [userId]
  );

  return result.rowCount === 0 ? null : result.rows[0];
}

// True when the user's role was changed after the token was issued. The
// one-second grace period absorbs clock skew between token signing and the
// role update landing in the database.
function isRoleStale(liveUser, token) {
  const tokenIssuedAt = Number(token.iat || 0);
  return liveUser.role_changed_at > new Date((tokenIssuedAt + 1) * 1000);
}

// Reads the token version from the JWT. Tokens issued before the version
// field existed default to 1, matching the database default.
function tokenVersionOf(token) {
  return token.token_version === undefined || token.token_version === null
    ? 1
    : Number(token.token_version);
}

// Requires any valid logged-in user. Verifies the JWT signature, then rejects
// the token when the user is gone or changed their password since it was
// issued (the token version no longer matches).
async function requireAuth(request, response, next) {
  const authorization = request.get('authorization');
  const [scheme, token] = authorization ? authorization.split(' ') : [];

  if (scheme !== 'Bearer' || !token) {
    return response.status(401).json({ error: 'A valid bearer token is required.' });
  }

  try {
    request.user = jwt.verify(token, env.jwtSecret);
  } catch (_error) {
    return response.status(401).json({ error: 'A valid bearer token is required.' });
  }

  try {
    const liveUser = await loadLiveUser(request.user.sub);

    if (!liveUser || Number(liveUser.token_version) !== tokenVersionOf(request.user)) {
      return response.status(401).json({ error: 'A valid bearer token is required.' });
    }

    request.liveUser = liveUser;
    return next();
  } catch (error) {
    return next(error);
  }
}

// Builds a gate for one or more roles (e.g. requireRole('admin')). Checks the
// token's claimed role first, then re-reads the live user row so demotions and
// role changes take effect immediately — old tokens must log in again.
function requireRole(...roles) {
  return async (request, response, next) => {
    if (!roles.includes(request.user.role)) {
      return response.status(403).json({ error: 'You do not have permission to perform this action.' });
    }

    try {
      const liveUser = request.liveUser || await loadLiveUser(request.user.sub);

      if (!liveUser) {
        return response.status(401).json({ error: 'A valid bearer token is required.' });
      }

      if (Number(liveUser.token_version) !== tokenVersionOf(request.user)) {
        return response.status(401).json({ error: 'A valid bearer token is required.' });
      }

      const roleChangedAfterToken = isRoleStale(liveUser, request.user);

      if (liveUser.role !== request.user.role || roleChangedAfterToken) {
        return response.status(403).json({ error: 'Your authorization is no longer valid. Please log in again.' });
      }

      request.liveUser = liveUser;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

// Only approved drivers pass. Rejects non-drivers, demoted drivers with stale
// tokens, and drivers whose application was never approved — so removing a
// driver instantly cuts off driver-only endpoints.
async function requireApprovedDriver(request, response, next) {
  if (request.user.role !== 'driver') {
    return response.status(403).json({ error: 'You do not have permission to perform this action.' });
  }

  try {
    const liveUser = request.liveUser || await loadLiveUser(request.user.sub);

    if (!liveUser) {
      return response.status(401).json({ error: 'A valid bearer token is required.' });
    }

    if (Number(liveUser.token_version) !== tokenVersionOf(request.user)) {
      return response.status(401).json({ error: 'A valid bearer token is required.' });
    }

    if (liveUser.role !== 'driver' || isRoleStale(liveUser, request.user)) {
      return response.status(403).json({ error: 'Your authorization is no longer valid. Please log in again.' });
    }

    if (liveUser.driver_application_status !== 'approved') {
      return response.status(403).json({ error: 'Driver approval is required for this action.' });
    }

    request.liveUser = liveUser;
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = { requireAuth, requireRole, requireApprovedDriver };