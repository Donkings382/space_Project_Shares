export function errorHandler(err, req, res, next) {
  console.error(err);

  const statusCode = err.statusCode || err.status || 500;
  const message =
    statusCode === 503
      ? err.message || "Service temporarily unavailable."
      : statusCode >= 500
        ? "Internal server error."
        : err.message || "Request failed.";

  res.status(statusCode).json({
    message,
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
}
