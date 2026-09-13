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
  assert.equal(restorePassword.status, 401);
  assert.deepEqual(restorePassword.body, { error: 'A valid bearer token is required.' });

  const loginAfterChange = await request(app)
    .post('/auth/login')
    .send({ email: testEmail, password: 'NewRideSafe123' });
  assert.equal(loginAfterChange.status, 200);
  const changedHeaders = { Authorization: `Bearer ${loginAfterChange.body.token}` };

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
    .set(changedHeaders)
    .send({ currentPassword: 'ResetRide123', newPassword: testPassword });
  assert.equal(restoreAfterReset.status, 401);
  assert.deepEqual(restoreAfterReset.body, { error: 'A valid bearer token is required.' });

  const finalLogin = await request(app)
    .post('/auth/login')
    .send({ email: testEmail, password: 'ResetRide123' });
  assert.equal(finalLogin.status, 200);
  const finalRestore = await request(app)
    .patch('/auth/me/password')
    .set('Authorization', `Bearer ${finalLogin.body.token}`)
    .send({ currentPassword: 'ResetRide123', newPassword: testPassword });
  assert.equal(finalRestore.status, 200);
});

test('rides require authentication', async () => {
  const response = await request(app).get('/rides');

  assert.equal(response.status, 401);
});

test('route IDs reject malformed values', async () => {
  const login = await request(app)
    .post('/auth/login')
    .send({ email: testEmail, password: testPassword });
  assert.equal(login.status, 200);
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
  assert.equal(login.status, 200);
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
  const riderId = rider.user.id;

  const adminLogin = await request(app)
    .post('/auth/login')
    .send({ email: testEmail, password: testPassword });
  const adminHeaders = { Authorization: `Bearer ${adminLogin.body.token}` };
  const application = await request(app)
    .post('/drivers/apply')
    .set({ Authorization: `Bearer ${driver.token}` });
  assert.equal(application.status, 202);
  assert.equal(application.body.application.driver_application_status, 'pending');

  const approvedApplication = await request(app)
    .patch(`/admin/driver-applications/${driverId}`)
    .set(adminHeaders)
    .send({ status: 'approved' });
  assert.equal(approvedApplication.status, 200);
  assert.equal(approvedApplication.body.application.role, 'driver');
  assert.equal(approvedApplication.body.application.driver_application_status, 'approved');

  const staleDriverTokenRejected = await request(app)
    .post('/drivers/apply')
    .set({ Authorization: `Bearer ${driver.token}` });
  assert.equal(staleDriverTokenRejected.status, 409);
  assert.deepEqual(staleDriverTokenRejected.body, { error: 'Only rider accounts can submit a driver application.' });

  const driverRelogin = await request(app)
    .post('/auth/login')
    .send({ email: driverEmail, password: testPassword });
  assert.equal(driverRelogin.status, 200);

  const applicationNotifications = await request(app)
    .get('/notifications')
    .set({ Authorization: `Bearer ${driverRelogin.body.token}` });
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

  const nonDriverAccept = await request(app)
    .patch(`/rides/${rideRequest.body.ride.id}/accept`)
    .set(riderHeaders)
    .send({ vehicleId: vehicle.id });
  assert.equal(nonDriverAccept.status, 403);
  assert.deepEqual(nonDriverAccept.body, { error: 'You do not have permission to perform this action.' });

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

  const assignDoubleBooking = await request(app)
    .patch(`/admin/rides/${secondRide.body.ride.id}/assign`)
    .set(adminHeaders)
    .send({ driverId, vehicleId: vehicle.id });
  assert.equal(assignDoubleBooking.status, 409);
  assert.equal(assignDoubleBooking.body.error, 'Driver already has an active ride.');

  const matchDoubleBookingRide = await request(app)
    .post('/rides')
    .set(riderHeaders)
    .send({
      pickupLocation: 'Third Pickup',
      dropoffLocation: 'Third Dropoff',
      pickupLatitude: 6.5244,
      pickupLongitude: 3.3792
    });
  assert.equal(matchDoubleBookingRide.status, 201);

  const matchDoubleBooking = await request(app)
    .post(`/admin/rides/${matchDoubleBookingRide.body.ride.id}/match`)
    .set(adminHeaders);
  assert.equal(matchDoubleBooking.status, 409);
  assert.equal(matchDoubleBooking.body.error, 'No available driver with a recent location was found.');

  const stillRequestedAfterMatch = await pool.query(
    'SELECT status FROM rides WHERE id = $1',
    [matchDoubleBookingRide.body.ride.id]
  );
  assert.equal(stillRequestedAfterMatch.rowCount, 1);
  assert.equal(stillRequestedAfterMatch.rows[0].status, 'requested');

  const activeRideCount = await pool.query(
    `SELECT COUNT(*) FROM rides
     WHERE driver_id = $1 AND status IN ('accepted', 'in_progress')`,
    [driverId]
  );
  assert.equal(Number(activeRideCount.rows[0].count), 1);

  const availabilityWhileBusy = await request(app)
    .patch('/drivers/me/availability')
    .set(driverHeaders)
    .send({ availability: 'available' });
  assert.equal(availabilityWhileBusy.status, 409);
  assert.equal(availabilityWhileBusy.body.error, 'Driver already has an active ride.');

  const stillBusy = await request(app)
    .get('/drivers/me')
    .set(driverHeaders);
  assert.equal(stillBusy.body.driver.availability, 'busy');

  const offlineWhileBusy = await request(app)
    .patch('/drivers/me/availability')
    .set(driverHeaders)
    .send({ availability: 'offline' });
  assert.equal(offlineWhileBusy.status, 200);

  const backToBusy = await request(app)
    .patch('/drivers/me/availability')
    .set(driverHeaders)
    .send({ availability: 'busy' });
  assert.equal(backToBusy.status, 200);

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

  const riderRide = await request(app)
    .get(`/rides/${rideRequest.body.ride.id}`)
    .set(riderHeaders);
  assert.equal(riderRide.status, 200);
  assert.ok('pickup_latitude' in riderRide.body.ride);
  assert.ok('pickup_longitude' in riderRide.body.ride);
  assert.equal(riderRide.body.ride.fare_confirmed_by_rider, false);

  const riderRides = await request(app)
    .get('/rides')
    .set(riderHeaders);
  assert.equal(riderRides.status, 200);
  assert.ok(riderRides.body.rides.some(
    (item) => item.id === rideRequest.body.ride.id
      && 'pickup_latitude' in item && 'pickup_longitude' in item
  ));

  const completeWithoutConfirm = await request(app)
    .patch(`/rides/${rideRequest.body.ride.id}/status`)
    .set(driverHeaders)
    .send({ status: 'completed' });
  assert.equal(completeWithoutConfirm.status, 409);
  assert.equal(completeWithoutConfirm.body.error, 'Rider has not confirmed the fare.');

  const nonRiderConfirm = await request(app)
    .patch(`/rides/${rideRequest.body.ride.id}/confirm-fare`)
    .set(driverHeaders);
  assert.equal(nonRiderConfirm.status, 409);

  const confirmedFare = await request(app)
    .patch(`/rides/${rideRequest.body.ride.id}/confirm-fare`)
    .set(riderHeaders);
  assert.equal(confirmedFare.status, 200);
  assert.equal(confirmedFare.body.ride.fare_confirmed_by_rider, true);

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

  const settledIntent = await request(app)
    .post(`/payments/rides/${rideRequest.body.ride.id}/intent`)
    .set(riderHeaders);
  assert.equal(settledIntent.status, 409);
  assert.equal(settledIntent.body.error, 'This ride already has a settled payment.');

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

  const demoted = await request(app)
    .patch(`/admin/users/${driverId}/role`)
    .set(adminHeaders)
    .send({ role: 'rider' });
  assert.equal(demoted.status, 200);
  assert.equal(demoted.body.user.driver_application_status, 'not_applicable');

  const staleDriverAccess = await request(app)
    .patch('/drivers/me/availability')
    .set(driverHeaders)
    .send({ availability: 'offline' });
  assert.equal(staleDriverAccess.status, 403);

  const staleDriverProfile = await request(app)
    .get('/drivers/me')
    .set(driverHeaders);
  assert.equal(staleDriverProfile.status, 403);

  const passwordStaleToken = riderHeaders.Authorization;

  const changedPassword = await request(app)
    .patch('/auth/me/password')
    .set(riderHeaders)
    .send({ currentPassword: testPassword, newPassword: 'RideSafe456' });
  assert.equal(changedPassword.status, 200);

  const oldPasswordTokenRejected = await request(app)
    .get('/auth/me')
    .set('Authorization', passwordStaleToken);
  assert.equal(oldPasswordTokenRejected.status, 401);

  const relogin = await request(app)
    .post('/auth/login')
    .send({ email: riderEmail, password: 'RideSafe456' });
  assert.equal(relogin.status, 200);
  const freshRiderHeaders = { Authorization: `Bearer ${relogin.body.token}` };

  const freshTokenWorks = await request(app)
    .get('/auth/me')
    .set(freshRiderHeaders);
  assert.equal(freshTokenWorks.status, 200);

  const changeBack = await request(app)
    .patch('/auth/me/password')
    .set(freshRiderHeaders)
    .send({ currentPassword: 'RideSafe456', newPassword: testPassword });
  assert.equal(changeBack.status, 200);

  const resetLogin = await request(app)
    .post('/auth/login')
    .send({ email: riderEmail, password: testPassword });
  assert.equal(resetLogin.status, 200);
  const resetHeaders = { Authorization: `Bearer ${resetLogin.body.token}` };

  const resetRequest = await request(app)
    .post('/auth/password-reset/request')
    .send({ email: riderEmail });
  assert.equal(resetRequest.status, 202);

  const resetConfirm = await request(app)
    .post('/auth/password-reset/confirm')
    .send({ token: resetRequest.body.resetToken, newPassword: 'RideSafe789' });
  assert.equal(resetConfirm.status, 200);

  const preResetTokenRejected = await request(app)
    .get('/auth/me')
    .set(resetHeaders);
  assert.equal(preResetTokenRejected.status, 401);

  const postResetLogin = await request(app)
    .post('/auth/login')
    .send({ email: riderEmail, password: 'RideSafe789' });
  assert.equal(postResetLogin.status, 200);
  const postResetHeaders = { Authorization: `Bearer ${postResetLogin.body.token}` };

  const restorePassword = await request(app)
    .patch('/auth/me/password')
    .set(postResetHeaders)
    .send({ currentPassword: 'RideSafe789', newPassword: testPassword });
  assert.equal(restorePassword.status, 200);
});

test('versioned API exposes the health endpoint', async () => {
  const response = await request(app).get('/api/v1/health');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok', database: 'connected' });
});

test('trusts one reverse proxy hop for client IP detection', () => {
  assert.equal(app.get('trust proxy'), 1);
});