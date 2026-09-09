const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const env = require('./config/env');
const { requestLogger } = require('./middleware/logging');
const healthRouter = require('./routes/health');
const authRouter = require('./routes/auth');
const ridesRouter = require('./routes/rides');
const vehiclesRouter = require('./routes/vehicles');
const adminRouter = require('./routes/admin');
const driversRouter = require('./routes/drivers');
const paymentsRouter = require('./routes/payments');
const notificationsRouter = require('./routes/notifications');

const app = express();
const apiV1 = express.Router();
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many authentication requests. Try again later.' }
});

app.use(helmet());
app.use(requestLogger);
app.use(cors({
  origin: env.corsOrigins.includes('*') ? '*' : env.corsOrigins,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

function mountApiRoutes(router) {
  router.use('/health', healthRouter);
  router.use('/auth', authLimiter, authRouter);
  router.use('/rides', ridesRouter);
  router.use('/vehicles', vehiclesRouter);
  router.use('/admin', adminRouter);
  router.use('/drivers', driversRouter);
  router.use('/payments', paymentsRouter);
  router.use('/notifications', notificationsRouter);
}

mountApiRoutes(app);
mountApiRoutes(apiV1);
app.use('/api/v1', apiV1);

app.use((_request, response) => {
  response.status(404).json({ error: 'Route not found.' });
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({
    status: 'error',
    message: env.nodeEnv === 'production'
      ? 'An unexpected server error occurred.'
      : error.message,
    requestId: response.getHeader('x-request-id')
  });
});

module.exports = app;
