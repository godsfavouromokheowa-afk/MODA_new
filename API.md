# MODA API

## Setup

Requirements: Node.js 20+ and PostgreSQL.

```powershell
npm install
createdb -U postgres moda
npm run migrate
npm start
```

To create the first administrator after registering the account, run this once:

```powershell
npm run bootstrap-admin -- user@example.com
```

The script refuses to run if an admin already exists. Later role changes should use the admin API.

Set `DATABASE_URL`, `DATABASE_SSL`, a random `JWT_SECRET` of at least 32 characters, and `CORS_ORIGINS` in `.env`. Placeholder JWT secrets containing `replace`, `example`, or `change-me` are rejected at startup.
Use a comma-separated origin list for deployed frontends, for example `https://app.example.com`.
The API listens on `http://localhost:3000`.
Versioned clients can use the same endpoints under `/api/v1`, for example `GET /api/v1/health`.
When deployed behind one Render, Railway, or equivalent reverse-proxy hop, Express trusts that hop for client IP and rate-limit detection.

## Tests

```powershell
npm test
```

## Authentication

Register or log in to receive a JWT, then send it as:

```http
Authorization: Bearer <token>
```

Authentication endpoints are rate-limited, and the API sends standard security headers.
All API routes allow up to 300 requests per 15 minutes per client IP. Authentication endpoints have an additional 50-request limit in the same window.
Every response includes an `x-request-id` header for tracing. Unknown routes return JSON `404` responses.
Admin authorization is checked against the database on each admin request, so role changes invalidate older JWTs immediately. This costs one extra indexed user lookup per admin request; caching is intentionally not used because revocation should take effect immediately.
Driver authorization is also checked against the live user row on every driver request: demoting a driver (or changing their approval status) invalidates their old driver JWT immediately.
Any role change, driver-approval decision, password change, or password reset requires the user to log in again — old tokens stop working.
Password change (`PATCH /auth/me/password`) and password reset confirmation (`POST /auth/password-reset/confirm`) bump an internal token version, so every previously issued token returns `401` on its next use.

| Method | Endpoint | Access |
| --- | --- | --- |
| POST | `/auth/register` | Public |
| POST | `/auth/login` | Public |
| POST | `/auth/password-reset/request` | Public |
| POST | `/auth/password-reset/confirm` | Public |
| GET | `/auth/me` | Authenticated |
| PATCH | `/auth/me` | Authenticated |
| PATCH | `/auth/me/password` | Authenticated |

Password reset requests always return a generic response. In development only, the response includes `resetToken` so the flow can be tested before an email provider is configured. Production should deliver that token through email or SMS instead.

## Rider endpoints

| Method | Endpoint | Access |
| --- | --- | --- |
| POST | `/rides` | Authenticated |
| GET | `/rides` | Authenticated — includes `pickup_latitude`, `pickup_longitude`, and `fare_confirmed_by_rider` |
| GET | `/rides/:id` | Authenticated — includes `pickup_latitude`, `pickup_longitude`, and `fare_confirmed_by_rider` |
| PATCH | `/rides/:id/cancel` | Authenticated |
| PATCH | `/rides/:id/confirm-fare` | Ride's rider only, while `accepted`/`in_progress` with a priced fare — sets `fare_confirmed_by_rider=true`, else `409` |

A ride can only transition to `completed` when it has a fare **and** the rider has confirmed it (`fare_confirmed_by_rider=true`); otherwise completion returns `409 { error: 'Rider has not confirmed the fare.' }`. Price the ride (`PATCH /rides/:id/pricing`), have the rider confirm (`PATCH /rides/:id/confirm-fare`), then complete it.

## Payment endpoints

| Method | Endpoint | Access | Purpose |
| --- | --- | --- | --- |
| POST | `/payments/rides/:id/intent` | Authenticated rider | Create or retrieve a pending NGN payment intent |
| GET | `/payments/:id` | Authenticated rider | View payment status |
| PATCH | `/payments/:id/mark-paid` | Assigned driver or admin | Confirm a cash payment for a completed ride |

Payment records are provider-neutral until Paystack or Flutterwave credentials are configured. The amount is copied from the completed ride fare and cannot be supplied by the client.
Repeating the intent for the same ride returns the same pending payment with `201`. If the payment is already settled (`paid`, `failed`, or `refunded`), the intent returns `409 { error: 'This ride already has a settled payment.' }`.

## Notification endpoints

| Method | Endpoint | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/notifications` | Authenticated | List the current user's notifications |
| PATCH | `/notifications/:id/read` | Authenticated | Mark a notification as read |

Ride acceptance, cancellation, and status changes create in-app notifications. SMS and push delivery can be added later.

Create a ride with:

```json
{
  "pickupLocation": "Airport Terminal 1",
  "dropoffLocation": "Central Station"
}
```

## Driver endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/drivers/me` | View driver availability and location |
| GET | `/drivers/me/rides` | View assigned ride history |
| POST | `/drivers/apply` | Submit a driver application |
| PATCH | `/drivers/me/availability` | Set `offline`, `available`, or `busy` — setting `available` while on an `accepted`/`in_progress` ride returns `409 { error: 'Driver already has an active ride.' }` |
| PATCH | `/drivers/me/location` | Update latitude and longitude |
| POST | `/vehicles` | Register a vehicle |
| GET | `/vehicles` | List owned vehicles |
| PATCH | `/vehicles/:id/status` | Activate or deactivate a vehicle |
| PATCH | `/vehicles/:id` | Edit a vehicle |
| DELETE | `/vehicles/:id` | Delete an unused vehicle |
| GET | `/rides/available/list` | List requested rides |
| PATCH | `/rides/:id/accept` | Accept a ride with an active vehicle |
| PATCH | `/rides/:id/status` | Set `in_progress`, `completed`, or `cancelled` |
| PATCH | `/rides/:id/pricing` | Set distance and current price per kilometre |

Ride pricing is immutable after it is first set. A second pricing request returns `409` so riders are not charged an unexpected revised fare.

Driver status transitions are enforced as follows:

```text
accepted -> in_progress -> completed
accepted -> cancelled
in_progress -> cancelled
```

Fare calculation uses Nigerian naira and the configured fare rules:

```text
distanceFare = BASE_FARE_NGN + (distanceKm * pricePerKm)
fare = max(MINIMUM_FARE_NGN, distanceFare)
```

`BASE_FARE_NGN` defaults to `0`. `MINIMUM_FARE_NGN` is required to be positive and defaults to `1000`. `MAX_PRICE_PER_KM_NGN` defaults to `2000`; adjust these values in `.env` as the platform collects real pricing data.

Example pricing body:

```json
{
  "distanceKm": 12.5,
  "pricePerKm": 250
}
```

This produces `NGN 3,125.00`.

## Admin endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/admin/users` | List users |
| GET | `/admin/driver-applications` | Review driver applications |
| PATCH | `/admin/driver-applications/:id` | Approve or reject an application |
| PATCH | `/admin/users/:id/role` | Set `rider`, `driver`, or `admin` — demoting a driver clears approval to `not_applicable`; any actual role change forces re-login |
| GET | `/admin/rides` | Monitor all rides |
| GET | `/admin/rides?status=requested` | Filter rides by status |
| PATCH | `/admin/rides/:id/assign` | Assign a matching driver and vehicle |
| POST | `/admin/rides/:id/match` | Assign the nearest available driver with a recent location |
| PATCH | `/admin/rides/:id/cancel` | Cancel an active ride |

## Health check

```http
GET /health
```

Expected response:

```json
{
  "status": "ok",
  "database": "connected"
}
```