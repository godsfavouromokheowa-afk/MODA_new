# MODA API

## Setup

Requirements: Node.js 20+ and PostgreSQL.

```powershell
npm install
createdb -U postgres moda
npm run migrate
npm start
```

Set `DATABASE_URL`, `DATABASE_SSL`, a long random `JWT_SECRET`, and `CORS_ORIGINS` in `.env`.
Use a comma-separated origin list for deployed frontends, for example `https://app.example.com`.
The API listens on `http://localhost:3000`.
Versioned clients can use the same endpoints under `/api/v1`, for example `GET /api/v1/health`.

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
Every response includes an `x-request-id` header for tracing. Unknown routes return JSON `404` responses.

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
| GET | `/rides` | Authenticated |
| GET | `/rides/:id` | Authenticated |
| PATCH | `/rides/:id/cancel` | Authenticated |

## Payment endpoints

| Method | Endpoint | Access | Purpose |
| --- | --- | --- | --- |
| POST | `/payments/rides/:id/intent` | Authenticated rider | Create or retrieve a pending NGN payment intent |
| GET | `/payments/:id` | Authenticated rider | View payment status |

Payment records are provider-neutral until Paystack or Flutterwave credentials are configured. The amount is copied from the completed ride fare and cannot be supplied by the client.

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
| PATCH | `/drivers/me/availability` | Set `offline`, `available`, or `busy` |
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

Both `BASE_FARE_NGN` and `MINIMUM_FARE_NGN` default to `0` and can be set in `.env`.

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
| PATCH | `/admin/users/:id/role` | Set `rider`, `driver`, or `admin` |
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