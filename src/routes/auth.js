// Authentication endpoints: public registration and login (issue JWTs),
// password change, and the request/confirm password-reset flow. Only the
// /me routes below require a logged-in user; everything else is public so new
// and logged-out users can sign up, sign in, or recover access.
const express = require('express');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');
const env = require('../config/env');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Signs a 7-day JWT carrying the user id, role, and token version. The token
// version is what lets password changes and resets invalidate older tokens.
function createToken(user) {
    return jwt.sign(
        { sub: String(user.id), role: user.role, token_version: Number(user.token_version ?? 1) },
        env.jwtSecret,
        { expiresIn: '7d' }
    );
}

// Shapes the safe user object sent to clients. Never includes the password
// hash or other internal columns.
function publicUser(user) {
    return {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
    };
}

// Hashes a reset token with SHA-256 so only the hash is stored — a database
// leak alone never reveals usable reset links.
function hashResetToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

// Public: creates an account. Normalizes the email and stores only a bcrypt
// hash of the password; a taken email returns 409.
router.post('/register', async (request, response, next) => {
    const { name, email, password } = request.body;

    if (
        typeof name !== 'string' || !name.trim() ||
        typeof email !== 'string' || !email.trim() ||
        typeof password !== 'string' || password.length < 8
    ) {
        return response.status(400).json({
            error: 'Name, email, and a password of at least 8 characters are required.'
        });
    }

    try {
        const normalizedEmail = email.trim().toLowerCase();
        const passwordHash = await bcrypt.hash(password, 12);
        const result = await pool.query(
            `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, role, token_version`,
            [name.trim(), normalizedEmail, passwordHash]
        );
        const user = result.rows[0];

        return response.status(201).json({
            user: publicUser(user),
            token: createToken(user)
        });
    } catch (error) {
        if (error.code === '23505') {
            return response.status(409).json({ error: 'An account with that email already exists.' });
        }
        return next(error);
    }
});

// Public: checks email + password and returns a fresh token. The error is
// deliberately generic so attackers can't probe which emails exist.
router.post('/login', async (request, response, next) => {
    const { email, password } = request.body;

    if (typeof email !== 'string' || typeof password !== 'string') {
        return response.status(400).json({ error: 'Email and password are required.' });
    }

    try {
        const result = await pool.query(
            'SELECT id, name, email, role, password_hash, token_version FROM users WHERE email = $1',
            [email.trim().toLowerCase()]
        );
        const user = result.rows[0];
        const passwordMatches = user && await bcrypt.compare(password, user.password_hash);

        if (!passwordMatches) {
            return response.status(401).json({ error: 'Invalid email or password.' });
        }

        return response.json({
            user: publicUser(user),
            token: createToken(user)
        });
    } catch (error) {
        return next(error);
    }
});

// Public: starts a password reset. Always returns the same generic message
// whether or not the email exists, so accounts can't be enumerated.
router.post('/password-reset/request', async (request, response, next) => {
    const { email } = request.body;
    const genericResponse = {
        message: 'If an account exists for that email, password reset instructions have been created.'
    };

    if (typeof email !== 'string' || !email.trim()) {
        return response.status(202).json(genericResponse);
    }

    try {
        const user = await pool.query(
            'SELECT id FROM users WHERE email = $1',
            [email.trim().toLowerCase()]
        );

        if (user.rowCount === 0) {
            return response.status(202).json(genericResponse);
        }

        const resetToken = crypto.randomBytes(32).toString('hex');
        await pool.query(
            `UPDATE password_reset_tokens SET used_at = NOW()
             WHERE user_id = $1 AND used_at IS NULL`,
            [user.rows[0].id]
        );
        await pool.query(
            `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
             VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
            [user.rows[0].id, hashResetToken(resetToken)]
        );

        if (env.nodeEnv !== 'production') {
            return response.status(202).json({ ...genericResponse, resetToken });
        }

        return response.status(202).json(genericResponse);
    } catch (error) {
        return next(error);
    }
});

// Public: finishes a password reset. Marks the reset token used and bumps the
// token version in one transaction, so every previously issued JWT stops
// working and the user must log in again.
router.post('/password-reset/confirm', async (request, response, next) => {
    const { resetToken, token, newPassword } = request.body;
    const suppliedToken = resetToken ?? token;

    if (
        typeof suppliedToken !== 'string' || !suppliedToken ||
        typeof newPassword !== 'string' || newPassword.length < 8
    ) {
        return response.status(400).json({ error: 'A reset token and a new password of at least 8 characters are required.' });
    }

    try {
        const tokenHash = hashResetToken(suppliedToken);
        const token = await pool.query(
            `SELECT id, user_id FROM password_reset_tokens
             WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()`,
            [tokenHash]
        );

        if (token.rowCount === 0) {
            return response.status(400).json({ error: 'The reset token is invalid or expired.' });
        }

        const passwordHash = await bcrypt.hash(newPassword, 12);
        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN');
            await client.query(
                'UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2',
                [passwordHash, token.rows[0].user_id]
            );
            const used = await client.query(
                `UPDATE password_reset_tokens SET used_at = NOW()
                 WHERE id = $1 AND used_at IS NULL`,
                [token.rows[0].id]
            );

            if (used.rowCount === 0) {
                await client.query('ROLLBACK');
                return response.status(400).json({ error: 'The reset token is invalid or expired.' });
            }

            await client.query('COMMIT');
        } catch (error) {
            if (client) {
                try { await client.query('ROLLBACK'); } catch (_) {}
            }
            throw error;
        } finally {
            if (client) client.release();
        }

        return response.json({ message: 'Password reset successfully.' });
    } catch (error) {
        return next(error);
    }
});

// Logged-in user: returns their own profile, including driver application
// status and current availability/location.
router.get('/me', requireAuth, async (request, response, next) => {
    try {
        const result = await pool.query(
            `SELECT id, name, email, role, driver_application_status,
                    availability, latitude, longitude, location_updated_at
             FROM users WHERE id = $1`,
            [request.user.sub]
        );

        if (result.rowCount === 0) {
            return response.status(404).json({ error: 'User not found.' });
        }

        return response.json({ user: result.rows[0] });
    } catch (error) {
        return next(error);
    }
});

// Logged-in user: renames their account or changes email. A taken email
// returns 409 via the database unique constraint.
router.patch('/me', requireAuth, async (request, response, next) => {
    const { name, email } = request.body;

    if (
        (name !== undefined && (typeof name !== 'string' || !name.trim())) ||
        (email !== undefined && (typeof email !== 'string' || !email.trim())) ||
        (name === undefined && email === undefined)
    ) {
        return response.status(400).json({ error: 'Provide a valid name or email to update.' });
    }

    try {
        const result = await pool.query(
            `UPDATE users
             SET name = COALESCE($1, name), email = COALESCE($2, email)
             WHERE id = $3
             RETURNING id, name, email, role, token_version`,
            [name === undefined ? null : name.trim(), email === undefined ? null : email.trim().toLowerCase(), request.user.sub]
        );

        if (result.rowCount === 0) {
            return response.status(404).json({ error: 'User not found.' });
        }

        return response.json({ user: result.rows[0] });
    } catch (error) {
        if (error.code === '23505') {
            return response.status(409).json({ error: 'An account with that email already exists.' });
        }
        return next(error);
    }
});

// Logged-in user: changes password after proving the current one. Bumps the
// token version so all older sessions are logged out immediately.
router.patch('/me/password', requireAuth, async (request, response, next) => {
    const { currentPassword, newPassword } = request.body;

    if (
        typeof currentPassword !== 'string' ||
        typeof newPassword !== 'string' ||
        newPassword.length < 8
    ) {
        return response.status(400).json({ error: 'Current password and a new password of at least 8 characters are required.' });
    }

    try {
        const result = await pool.query(
            'SELECT password_hash FROM users WHERE id = $1',
            [request.user.sub]
        );
        const user = result.rows[0];
        const passwordMatches = user && await bcrypt.compare(currentPassword, user.password_hash);

        if (!passwordMatches) {
            return response.status(401).json({ error: 'Current password is incorrect.' });
        }

        const passwordHash = await bcrypt.hash(newPassword, 12);
        await pool.query(
            'UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2',
            [passwordHash, request.user.sub]
        );

        return response.json({ message: 'Password updated successfully. Please log in again.' });
    } catch (error) {
        return next(error);
    }
});

module.exports = router;