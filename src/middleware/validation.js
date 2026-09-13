// Route-parameter validation: builds a guard that only lets positive integer
// IDs (ride IDs, vehicle IDs, user IDs) reach the handler, so malformed URLs
// get a clean 400 instead of hitting the database.
function requirePositiveIntegerParam(parameterName) {
  return (request, response, next) => {
    const value = Number(request.params[parameterName]);

    if (!Number.isSafeInteger(value) || value < 1) {
      return response.status(400).json({ error: `A valid ${parameterName} is required.` });
    }

    return next();
  };
}

module.exports = { requirePositiveIntegerParam };