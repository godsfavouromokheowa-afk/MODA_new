const dotenv = require('dotenv');

dotenv.config();

const port = Number.parseInt(process.env.PORT || '3000', 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a valid TCP port number.');
}

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

const corsOrigins = (process.env.CORS_ORIGINS || (process.env.NODE_ENV === 'production' ? '' : '*'))
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

if (corsOrigins.length === 0) {
  throw new Error('CORS_ORIGINS is required in production.');
}

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
  baseFareNgn: parseNonNegativeMoney('BASE_FARE_NGN'),
  corsOrigins,
  databaseUrl: process.env.DATABASE_URL,
  databaseSsl: process.env.DATABASE_SSL === 'true',
  jwtSecret,
  maxPricePerKmNgn: parsePositiveMoney('MAX_PRICE_PER_KM_NGN'),
  minimumFareNgn: parsePositiveMoney('MINIMUM_FARE_NGN'),
  nodeEnv: process.env.NODE_ENV || 'development',
  port
};
