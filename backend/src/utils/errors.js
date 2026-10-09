export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}
// A `details.code` overrides the generic code so callers can raise specific, stable error codes
// (e.g. forbidden('..', { code: 'UNDERAGE' })) while keeping one factory per HTTP status.
const mk = (status, code) => (message, details) => {
  const { code: specific, ...rest } = details || {};
  return new AppError(status, specific || code, message || code, Object.keys(rest).length ? rest : undefined);
};
export const badRequest = mk(400, 'BAD_REQUEST');
export const unauthorized = mk(401, 'UNAUTHORIZED');
export const forbidden = mk(403, 'FORBIDDEN');
export const notFound = mk(404, 'NOT_FOUND');
export const conflict = mk(409, 'CONFLICT');
export const gone = mk(410, 'GONE');
export const tooMany = (message, retryAfterSec) =>
  new AppError(429, 'RATE_LIMITED', message || 'Too many requests', { retryAfterSec });
export const banned = (message, details) => new AppError(403, 'BANNED', message || 'You are banned', details);
export const validation = (issues) => new AppError(422, 'VALIDATION', 'Invalid input', { issues });

/** Normalise any thrown value into a safe, typed payload for HTTP and socket acks. */
export function toErrorPayload(err) {
  if (err instanceof AppError) return { status: err.status, ...err.toJSON() };
  if (err?.name === 'ZodError') {
    return {
      status: 422,
      error: {
        code: 'VALIDATION',
        message: 'Invalid input',
        details: { issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      },
    };
  }
  return { status: 500, error: { code: 'INTERNAL', message: 'Internal error' } };
}
