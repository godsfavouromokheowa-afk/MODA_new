const assert = require('node:assert/strict');
const { after, test } = require('node:test');
const request = require('supertest');
const app = require('../src/app');
const { pool } = require('../src/config/database');
const env = require('../src/config/env');

const testRunId = Date.now();
const testEmail = `test-${testRunId}@example.com`;
const testPassword = 'RideSafe123';
const driverEmail = `driver-${testRunId}@example.com`;
const riderEmail = `rider-${testRunId}@example.com`;

test('JWT secret meets minimum security requirements', () => {
  assert.ok(env.jwtSecret.length >= 32);
  assert.doesNotMatch(env.jwtSecret, /replace|example|change[-_ ]?me|your[-_ ]?secret/i);
});

async function registerUser(name, email) {
  const response = await request(app)
    .post('/auth/register')
    .send({ name, email, password: testPassword });

  assert.equal(response.status, 201);
  return response.body;
}

after(async () => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM payments
       WHERE rider_id IN (SELECT id FROM users WHERE email IN ($1, $2, $3))`,
      [testEmail, driverEmail, riderEmail]
    );
    await client.query(
      `DELETE FROM rides WHERE rider_id IN (SELECT id FROM users WHERE email IN ($1, $2, $3))
       OR driver_id IN (SELECT id FROM users WHERE email IN ($1, $2, $3))`,
      [testEmail, driverEmail, riderEmail]
    );
    await client.query(
      'DELETE FROM vehicles WHERE driver_id IN (SELECT id FROM users WHERE email IN ($1, $2, $3))',
      [testEmail, driverEmail, riderEmail]
    );
    await client.query(
      'DELETE FROM users WHERE email IN ($1, $2, $3)',
      [testEmail, driverEmail, riderEmail]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  await pool.end();
});

test('health reports a connected database', async () => {
  const response = await request(app).get('/health');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok', database: 'connected' });
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['access-control-allow-origin'], '*');
  assert.ok(response.headers['x-request-id']);
  assert.match(response.headers.ratelimit, /300-in-15min/);
});

test('unknown routes return JSON errors with request IDs', async () => {
  const response = await request(app).get('/does-not-exist');

  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { error: 'Route not found.' });
  assert.ok(response.headers['x-request-id']);
});

test('registration and login return public user data and a token', async () => {
  const registration = await request(app)
    .post('/auth/register')
    .send({ name: 'Test Rider', email: testEmail, password: testPassword });

  assert.equal(registration.status, 201);
  assert.equal(registration.body.user.email, testEmail);
  assert.equal(typeof registration.body.token, 'string');
  assert.equal(registration.body.user.password_hash, undefined);

  const login = await request(app)
    .post('/auth/login')
    .send({ email: testEmail, password: testPassword });

  assert.equal(login.status, 200);
  assert.equal(login.body.user.id, registration.body.user.id);
  assert.equal(typeof login.body.token, 'string');

  const headers = { Authorization: `Bearer ${registration.body.token}` };
  const profile = await request(app)
    .get('/auth/me')
    .set(headers);
  assert.equal(profile.status, 200);
  assert.equal(profile.body.user.email, testEmail);

  const profileUpdate = await request(app)
    .patch('/auth/me')
    .set(headers)
    .send({ name: 'Updated Rider' });
  assert.equal(profileUpdate.status, 200);
  assert.equal(profileUpdate.body.user.name, 'Updated Rider');

  const passwordChange = await request(app)
    .patch('/auth/me/password')
    .set(headers)
    .send({ currentPassword: testPassword, newPassword: 'NewRideSafe123' });
  assert.equal(passwordChange.status, 200);

  const restorePassword = await request(app)
    .patch('/auth/me/password')
    .set(headers)
    .send({ currentPassword: 'NewRideSafe123', newPassword: testPassword });
  assert.equal(restorePassword.status, 200);

  const resetRequest = await request(app)
    .post('/auth/password-reset/request')
    .send({ email: testEmail });
  assert.equal(resetRequest.status, 202);
  assert.equal(typeof resetRequest.body.resetToken, 'string');

  const resetConfirmation = await request(app)
    .post('/auth/password-reset/confirm')
    .send({ resetToken: resetRequest.body.resetToken, newPassword: 'ResetRide123' });
  assert.equal(resetConfirmation.status, 200);

  const reusedToken = await request(app)
    .post('/auth/password-reset/confirm')
    .send({ resetToken: resetRequest.body.resetToken, newPassword: testPassword });
  assert.equal(reusedToken.status, 400);

  const restoreAfterReset = await request(app)
    .patch('/auth/me/password')
    .set(headers)
    .send({ currentPassword: 'ResetRide123', newPassword: testPassword });
  assert.equal(restoreAfterReset.status, 200);
});

test('rides require authentication', async () => {
  const response = await request(app).get('/rides');

  assert.equal(response.status, 401);
});

test('route IDs reject malformed values', async () => {
  const login = await request(app)
    .post('/auth/login')
    .send({ email: testEmail, password: testPassword });
  const response = await request(app)
    .get('/rides/not-an-id')
    .set('Authorization', `Bearer ${login.body.token}`);

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: 'A valid id is required.' });
});

test('admins cannot demote their own account', async () => {
  await pool.query('UPDATE users SET role = $1 WHERE email = $2', ['admin', testEmail]);
  const login = await request(app)
    .post('/auth/login')
    .send({ email: testEmail, password: testPassword });
  const response = await request(app)
    .patch(`/admin/users/${login.body.user.id}/role`)
    .set('Authorization', `Bearer ${login.body.token}`)
    .send({ role: 'rider' });

  assert.equal(response.status, 409);
  assert.deepEqual(response.body, { error: 'An admin cannot demote their own account.' });

  await pool.query(
    `UPDATE users SET role = 'rider', role_changed_at = NOW() WHERE email = $1`,
    [testEmail]
  );
  const staleTokenResponse = await request(app)
    .get('/admin/users')
    .set('Authorization', `Bearer ${login.body.token}`);
  assert.equal(staleTokenResponse.status, 403);

  await pool.query(
    `UPDATE users SET role = 'admin', role_changed_at = NOW() - INTERVAL '2 seconds'
     WHERE email = $1`,
    [testEmail]
  );
});

test('driver workflow enforces roles and calculates NGN pricing', async () => {
  const driver = await registerUser('Test Driver', driverEmail);
  const rider = await registerUser('Test Rider', riderEmail);
  const driverId = driver.user.id;

  const adminLogin = await request(app)
    .post('/auth/login')
    .send({ email: testEmail, password: testPassword });
  const adminHeaders = { Authorization: `Bearer ${adminLogin.body.token}` };
  const application = await request(app)
    .post('/drivers/apply')
    .set({ Authorization: `Bearer ${rider.token}` });
  assert.equal(application.status, 202);
  assert.equal(application.body.application.driver_application_status, 'pending');

  const approvedApplication = await request(app)
    .patch(`/admin/driver-applications/${rider.user.id}`)
    .set(adminHeaders)
    .send({ status: 'approved' });
  assert.equal(approvedApplication.status, 200);
  assert.equal(approvedApplication.body.application.role, 'driver');
  assert.equal(approvedApplication.body.application.driver_application_status, 'approved');

  const applicationNotifications = await request(app)
    .get('/notifications')
    .set({ Authorization: `Bearer ${rider.token}` });
  assert.ok(applicationNotifications.body.notifications.some(
    (notification) => notification.type === 'driver_application_approved'
  ));

  await pool.query(
    `UPDATE users
     SET role = 'driver', driver_application_status = 'approved'
     WHERE id = $1`,
    [driverId]
  );
  const driverLogin = await request(app)
    .post('/auth/login')
    .send({ email: driverEmail, password: testPassword });
  const driverHeaders = { Authorization: `Bearer ${driverLogin.body.token}` };
  const riderHeaders = { Authorization: `Bearer ${rider.token}` };

  const availability = await request(app)
    .patch('/drivers/me/availability')
    .set(driverHeaders)
    .send({ availability: 'available' });
  assert.equal(availability.status, 200);
  assert.equal(availability.body.driver.availability, 'available');

  const invalidLocation = await request(app)
    .patch('/drivers/me/location')
    .set(driverHeaders)
    .send({ latitude: 95, longitude: 3.4 });
  assert.equal(invalidLocation.status, 400);

  const location = await request(app)
    .patch('/drivers/me/location')
    .set(driverHeaders)
    .send({ latitude: 6.5244, longitude: 3.3792 });
  assert.equal(location.status, 200);
  assert.equal(location.body.driver.latitude, '6.524400');
  assert.equal(location.body.driver.longitude, '3.379200');

  const riderVehicleAttempt = await request(app)
    .post('/vehicles')
    .set(driverHeaders)
    .send({ make: 'Toyota', model: 'Corolla', licensePlate: `TEST${Date.now()}` });
  assert.equal(riderVehicleAttempt.status, 201);

  const riderCannotUseVehicleEndpoint = await request(app)
    .get('/vehicles')
    .set(riderHeaders);
  assert.equal(riderCannotUseVehicleEndpoint.status, 403);

  const vehicle = riderVehicleAttempt.body.vehicle;
  const editedVehicle = await request(app)
    .patch(`/vehicles/${vehicle.id}`)
    .set(driverHeaders)
    .send({ make: 'Honda', model: 'Civic', licensePlate: `EDIT${Date.now()}` });
  assert.equal(editedVehicle.status, 200);
  assert.equal(editedVehicle.body.vehicle.make, 'Honda');

  const unusedVehicle = await request(app)
    .post('/vehicles')
    .set(driverHeaders)
    .send({ make: 'Kia', model: 'Rio', licensePlate: `UNUSED${Date.now()}` });
  assert.equal(unusedVehicle.status, 201);

  const deletedUnusedVehicle = await request(app)
    .delete(`/vehicles/${unusedVehicle.body.vehicle.id}`)
    .set(driverHeaders);
  assert.equal(deletedUnusedVehicle.status, 204);

  const matchRideRequest = await request(app)
    .post('/rides')
    .set(riderHeaders)
    .send({
      pickupLocation: 'Lagos Island',
      dropoffLocation: 'Victoria Island',
      pickupLatitude: 6.5244,
      pickupLongitude: 3.3792
    });
  assert.equal(matchRideRequest.status, 201);

  const matched = await request(app)
    .post(`/admin/rides/${matchRideRequest.body.ride.id}/match`)
    .set(adminHeaders);
  assert.equal(matched.status, 200);
  assert.equal(matched.body.ride.status, 'accepted');
  assert.ok(Number(matched.body.match.driverId) > 0);
  assert.ok(Number(matched.body.match.vehicleId) > 0);

  const cancelledMatchedRide = await request(app)
    .patch(`/admin/rides/${matchRideRequest.body.ride.id}/cancel`)
    .set(adminHeaders);
  assert.equal(cancelledMatchedRide.status, 200);

  const cancellationNotifications = await request(app)
    .get('/notifications')
    .set(riderHeaders);
  assert.ok(cancellationNotifications.body.notifications.some(
    (notification) => notification.type === 'ride_cancelled'
      && String(notification.data.rideId) === String(matchRideRequest.body.ride.id)
  ));

  const availableAfterCancel = await request(app)
    .get('/drivers/me')
    .set(driverHeaders);
  assert.equal(availableAfterCancel.status, 200);
  assert.equal(availableAfterCancel.body.driver.availability, 'available');

  const rideRequest = await request(app)
    .post('/rides')
    .set(riderHeaders)
    .send({ pickupLocation: 'Airport', dropoffLocation: 'Station' });
  assert.equal(rideRequest.status, 201);

  const invalidCompletion = await request(app)
    .patch(`/rides/${rideRequest.body.ride.id}/status`)
    .set(driverHeaders)
    .send({ status: 'completed' });
  assert.equal(invalidCompletion.status, 409);

  const accepted = await request(app)
    .patch(`/rides/${rideRequest.body.ride.id}/accept`)
    .set(driverHeaders)
    .send({ vehicleId: vehicle.id });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.ride.status, 'accepted');

  const busyAfterAccept = await request(app)
    .get('/drivers/me')
    .set(driverHeaders);
  assert.equal(busyAfterAccept.body.driver.availability, 'busy');

  const secondRide = await request(app)
    .post('/rides')
    .set(riderHeaders)
    .send({ pickupLocation: 'Second Pickup', dropoffLocation: 'Second Dropoff' });
  const doubleBooking = await request(app)
    .patch(`/rides/${secondRide.body.ride.id}/accept`)
    .set(driverHeaders)
    .send({ vehicleId: vehicle.id });
  assert.equal(doubleBooking.status, 409);

  const excessiveRate = await request(app)
    .patch(`/rides/${rideRequest.body.ride.id}/pricing`)
    .set(driverHeaders)
    .send({ distanceKm: 1, pricePerKm: 2000.01 });
  assert.equal(excessiveRate.status, 400);

  const prematurePricing = await request(app)
    .patch(`/rides/${secondRide.body.ride.id}/pricing`)
    .set(driverHeaders)
    .send({ distanceKm: 1, pricePerKm: 0 });
  assert.equal(prematurePricing.status, 409);

  const notifications = await request(app)
    .get('/notifications')
    .set(riderHeaders);
  assert.equal(notifications.status, 200);
  const acceptanceNotification = notifications.body.notifications.find(
    (notification) => notification.type === 'ride_accepted'
  );
  assert.ok(acceptanceNotification);

  const readNotification = await request(app)
    .patch(`/notifications/${acceptanceNotification.id}/read`)
    .set(riderHeaders);
  assert.equal(readNotification.status, 200);
  assert.ok(readNotification.body.notification.read_at);

  const pricing = await request(app)
    .patch(`/rides/${rideRequest.body.ride.id}/pricing`)
    .set(driverHeaders)
    .send({ distanceKm: 12.5, pricePerKm: 250 });
  assert.equal(pricing.status, 200);
  assert.equal(pricing.body.ride.fare, '3125.00');
  assert.equal(pricing.body.ride.currency, 'NGN');

  const repricing = await request(app)
    .patch(`/rides/${rideRequest.body.ride.id}/pricing`)
    .set(driverHeaders)
    .send({ distanceKm: 1, pricePerKm: 250 });
  assert.equal(repricing.status, 409);

  const inProgress = await request(app)
    .patch(`/rides/${rideRequest.body.ride.id}/status`)
    .set(driverHeaders)
    .send({ status: 'in_progress' });
  assert.equal(inProgress.status, 200);
  assert.equal(inProgress.body.ride.status, 'in_progress');

  const completed = await request(app)
    .patch(`/rides/${rideRequest.body.ride.id}/status`)
    .set(driverHeaders)
    .send({ status: 'completed' });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.ride.status, 'completed');

  const availableAfterCompletion = await request(app)
    .get('/drivers/me')
    .set(driverHeaders);
  assert.equal(availableAfterCompletion.body.driver.availability, 'available');

  const acceptedSecondRide = await request(app)
    .patch(`/rides/${secondRide.body.ride.id}/accept`)
    .set(driverHeaders)
    .send({ vehicleId: vehicle.id });
  assert.equal(acceptedSecondRide.status, 200);

  const minimumFare = await request(app)
    .patch(`/rides/${secondRide.body.ride.id}/pricing`)
    .set(driverHeaders)
    .send({ distanceKm: 1, pricePerKm: 0 });
  assert.equal(minimumFare.status, 200);
  assert.equal(minimumFare.body.ride.fare, '1000.00');

  const cancelledSecondRide = await request(app)
    .patch(`/rides/${secondRide.body.ride.id}/status`)
    .set(driverHeaders)
    .send({ status: 'cancelled' });
  assert.equal(cancelledSecondRide.status, 200);

  const paymentIntent = await request(app)
    .post(`/payments/rides/${rideRequest.body.ride.id}/intent`)
    .set(riderHeaders);
  assert.equal(paymentIntent.status, 201);
  assert.equal(paymentIntent.body.payment.amount, '3125.00');
  assert.equal(paymentIntent.body.payment.currency, 'NGN');
  assert.equal(paymentIntent.body.payment.status, 'pending');

  const repeatedPaymentIntent = await request(app)
    .post(`/payments/rides/${rideRequest.body.ride.id}/intent`)
    .set(riderHeaders);
  assert.equal(repeatedPaymentIntent.status, 201);
  assert.equal(repeatedPaymentIntent.body.payment.id, paymentIntent.body.payment.id);

  const payment = await request(app)
    .get(`/payments/${paymentIntent.body.payment.id}`)
    .set(riderHeaders);
  assert.equal(payment.status, 200);
  assert.equal(payment.body.payment.provider, 'unconfigured');

  const markedPaid = await request(app)
    .patch(`/payments/${paymentIntent.body.payment.id}/mark-paid`)
    .set(driverHeaders);
  assert.equal(markedPaid.status, 200);
  assert.equal(markedPaid.body.payment.status, 'paid');
  assert.equal(markedPaid.body.payment.provider, 'cash');
  assert.equal(String(markedPaid.body.payment.confirmed_by_user_id), String(driverId));

  const markedPaidAgain = await request(app)
    .patch(`/payments/${paymentIntent.body.payment.id}/mark-paid`)
    .set(driverHeaders);
  assert.equal(markedPaidAgain.status, 409);

  const driverHistory = await request(app)
    .get('/drivers/me/rides')
    .set(driverHeaders);
  assert.equal(driverHistory.status, 200);
  assert.ok(driverHistory.body.rides.some((item) => item.id === rideRequest.body.ride.id));

  const cannotDeleteUsedVehicle = await request(app)
    .delete(`/vehicles/${vehicle.id}`)
    .set(driverHeaders);
  assert.equal(cannotDeleteUsedVehicle.status, 409);

  const cancellableRide = await request(app)
    .post('/rides')
    .set(riderHeaders)
    .send({ pickupLocation: 'Mall', dropoffLocation: 'Home' });
  const cancelled = await request(app)
    .patch(`/rides/${cancellableRide.body.ride.id}/cancel`)
    .set(riderHeaders);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.ride.status, 'cancelled');
});

test('versioned API exposes the health endpoint', async () => {
  const response = await request(app).get('/api/v1/health');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok', database: 'connected' });
});

test('trusts one reverse proxy hop for client IP detection', () => {
  assert.equal(app.get('trust proxy'), 1);
});