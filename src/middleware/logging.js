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