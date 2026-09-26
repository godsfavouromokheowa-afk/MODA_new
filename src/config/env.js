// Environment configuration: loads .env, validates every required setting at
// startup, and exports typed values (ports, money rules, secrets, CORS list)
// so the rest of the app never reads process.env directly.
const dotenv = require('dotenv');

dotenv.config();

const nodeEnv = process.env.NODE_ENV || 'development';

function parseBoolean(name, defaultValue) {
  const raw = process.env[name];

  if (raw === undefined || raw === '') {
    return defaultValue;
  }

  if (raw === 'true' || raw === '1') {
    return true;
  }

  if (raw === 'false' || raw === '0') {
    return false;
  }

  throw new Error(`${name} must be true or false.`);
}

// Fail fast on a bad port so the server never binds to an unintended address.
const port = Number.parseInt(process.env.PORT || '3000', 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a valid TCP port number.');
}

// Crash at boot (rather than on first request) when secrets or the database
// URL are missing or look like unreplaced placeholders.
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Copy .env.example to .env and configure PostgreSQL.');
}

const jwtSecret = process.env.JWT_SECRET;

if (!jwtSecret) {
  throw new Error('JWT_SECRET is required. Add a long random value to .env.');
}

if (
  jwtSecret.length < 32 ||
  /replace|example|change[-_ ]?me|your[-_ ]?secret/i.test(jwtSecret)
) {
  throw new Error('JWT_SECRET must be at least 32 characters and cannot be a placeholder value.');
}

// In development any frontend may call the API; in production the allow-list
// must be explicit so browsers block unknown origins.
const corsOrigins = (process.env.CORS_ORIGINS || (nodeEnv === 'production' ? '' : '*'))
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

if (corsOrigins.length === 0) {
  throw new Error('CORS_ORIGINS is required in production.');
}

if (nodeEnv === 'production' && corsOrigins.includes('*')) {
  throw new Error('CORS_ORIGINS cannot include * in production. Set explicit https origins.');
}

const databaseSsl = parseBoolean('DATABASE_SSL', false);
const databaseSslRejectUnauthorized = parseBoolean(
  'DATABASE_SSL_REJECT_UNAUTHORIZED',
  nodeEnv === 'production'
);
const databaseSslCa = process.env.DATABASE_SSL_CA || '';

const smtpHost = (process.env.SMTP_HOST || '').trim();
const smtpPort = Number.parseInt(process.env.SMTP_PORT || '587', 10);
const smtpUser = process.env.SMTP_USER || '';
const smtpPass = process.env.SMTP_PASS || '';
const smtpFrom = (process.env.SMTP_FROM || '').trim();
const appPublicUrl = (process.env.APP_PUBLIC_URL || '').trim().replace(/\/$/, '');

if (smtpHost) {
  if (!smtpFrom) {
    throw new Error('SMTP_FROM is required when SMTP_HOST is set.');
  }

  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
    throw new Error('SMTP_PORT must be a valid TCP port number.');
  }
} else if (nodeEnv === 'production') {
  console.warn('SMTP_HOST is not set. Password reset emails will not be delivered until SMTP is configured.');
}

// Parse a fare-rule env var as naira rounded to the nearest kobo, so pricing
// math elsewhere never sees raw floats or negative values.
function parseNonNegativeMoney(name) {
  const value = Number.parseFloat(process.env[name] || '0');

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }

  return Math.round(value * 100) / 100;
}

function parsePositiveMoney(name) {
  const value = Number.parseFloat(process.env[name] || '0');

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }

  return Math.round(value * 100) / 100;
}

module.exports = {
  appPublicUrl,
  baseFareNgn: parseNonNegativeMoney('BASE_FARE_NGN'),
  corsOrigins,
  databaseUrl: process.env.DATABASE_URL,
  databaseSsl,
  databaseSslCa,
  databaseSslRejectUnauthorized,
  jsonBodyLimit: '32kb',
  jwtSecret,
  maxPricePerKmNgn: parsePositiveMoney('MAX_PRICE_PER_KM_NGN'),
  minimumFareNgn: parsePositiveMoney('MINIMUM_FARE_NGN'),
  nodeEnv,
  port,
  smtpFrom,
  smtpHost,
  smtpPass,
  smtpPort,
  smtpUser
};
