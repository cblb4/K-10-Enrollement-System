/**
 * errorHandler — centralized Express error middleware + HttpError helper.
 *
 * Controllers throw HttpError(status, message, details?) and this handler
 * converts them to JSON responses. Anything else (programming error, DB
 * failure, etc.) becomes a 500 with a generic message — full details are
 * logged server-side but never leaked to the client.
 */
'use strict';

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

// MySQL error codes we want to translate to friendlier client errors.
const MYSQL_FRIENDLY = {
  ER_DUP_ENTRY:           [409, 'A record with that value already exists.'],
  ER_NO_REFERENCED_ROW_2: [400, 'Referenced record does not exist.'],
  ER_ROW_IS_REFERENCED_2: [409, 'Cannot delete: this record is referenced by other records.']
};

function errorHandler(err, req, res, _next) {
  // Known, intentional errors thrown by controllers.
  if (err instanceof HttpError) {
    const body = { error: err.message };
    if (err.details !== undefined) body.details = err.details;
    return res.status(err.status).json(body);
  }

  // MySQL errors with friendly translations.
  if (err && err.code && MYSQL_FRIENDLY[err.code]) {
    const [status, message] = MYSQL_FRIENDLY[err.code];
    return res.status(status).json({ error: message });
  }

  // Body parser errors (e.g. malformed JSON).
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON body' });
  }

  // Anything else is unexpected — log it, send a generic message.
  // eslint-disable-next-line no-console
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
}

// Wraps an async route handler so any rejected promise flows to errorHandler
// instead of being silently swallowed.
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { HttpError, errorHandler, asyncHandler };
