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