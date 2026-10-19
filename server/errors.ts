export type ErrorCode =
  | 'invalid'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'too_large'
  | 'rate_limited'
  | 'storage_full';

const STATUS: Record<ErrorCode, number> = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  too_large: 413,
  rate_limited: 429,
  storage_full: 507,
};

/** An error whose message is written for the person (or agent) who caused it. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  retryAfter?: number;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
  }
}

export const invalid = (message: string) => new AppError('invalid', message);
