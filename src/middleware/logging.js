// Request logging: stamps every request with an ID (reusing the caller's when
// provided) and logs one JSON line with method, path, status, and duration
// once the response finishes — this is how requests are traced in production.
const crypto = require('node:crypto');

function requestLogger(request, response, next) {
  const requestId = request.get('x-request-id') || crypto.randomUUID();
  const startedAt = Date.now();

  response.setHeader('x-request-id', requestId);
  response.on('finish', () => {
    console.log(JSON.stringify({
      requestId,
      method: request.method,
      path: request.originalUrl,
      status: response.statusCode,
      durationMs: Date.now() - startedAt
    }));
  });

  return next();
}

module.exports = { requestLogger };