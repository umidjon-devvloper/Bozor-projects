import { ERROR_STATUS, ERROR_TITLE, ErrorCode } from './codes.js';

export interface FieldError {
  field: string;
  code: string;
  params?: Record<string, unknown>;
}

export interface AppErrorOptions {
  /** Developer-facing detail. Logged, returned to clients, never shown to end users. */
  detail?: string;
  /** Exhaustive field-level failures for 422 responses. */
  errors?: FieldError[];
  /** Structured data the client uses to render a translated message. */
  params?: Record<string, unknown>;
  /** Extra payload merged into the response body (e.g. a fresh quote on QUOTE_STALE). */
  extra?: Record<string, unknown>;
  cause?: unknown;
  /** Overrides the catalog status. Used sparingly; the catalog is the default. */
  status?: number;
  /**
   * The real reason, when the client is deliberately told something less specific.
   * ADR-0029: scope denials return 404 but log PERM_SCOPE_DENIED.
   */
  internalReason?: string;
}

export class AppError extends Error {
  /*
   * These use `declare` deliberately.
   *
   * With `useDefineForClassFields` semantics — the default for modern targets, and what
   * esbuild applies regardless of tsconfig — a bare field declaration emits a
   * `defineProperty(this, 'code', undefined)` that runs after `super()` and *overwrites*
   * whatever the constructor body assigned. The result is an error object whose `code` and
   * `status` are silently undefined, which in this system means every error response loses
   * the field clients translate on. `declare` emits nothing, so the constructor assignment
   * is the only writer. Covered by a regression test in AppError.test.ts.
   */
  declare readonly code: ErrorCode;
  declare readonly status: number;
  declare readonly detail: string | undefined;
  declare readonly errors: FieldError[] | undefined;
  declare readonly params: Record<string, unknown> | undefined;
  declare readonly extra: Record<string, unknown> | undefined;
  declare readonly internalReason: string | undefined;
  /** Operational errors are expected; non-operational ones mean the process state is unknown. */
  declare readonly isOperational: boolean;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    super(options.detail ?? ERROR_TITLE[code] ?? code);
    this.name = 'AppError';
    this.isOperational = true;
    this.code = code;
    this.status = options.status ?? ERROR_STATUS[code];
    this.detail = options.detail;
    this.errors = options.errors;
    this.params = options.params;
    this.extra = options.extra;
    this.internalReason = options.internalReason;
    if (options.cause !== undefined) this.cause = options.cause;
    Error.captureStackTrace(this, AppError);
  }

  get title(): string {
    return ERROR_TITLE[this.code] ?? this.code;
  }

  static isAppError(value: unknown): value is AppError {
    return value instanceof AppError;
  }
}

/** Shorthand constructors for the codes used most often. */
export const unauthorized = (code: ErrorCode = ErrorCode.AUTH_REQUIRED, detail?: string) =>
  new AppError(code, detail !== undefined ? { detail } : {});

export const forbidden = (detail?: string) =>
  new AppError(ErrorCode.PERM_DENIED, detail !== undefined ? { detail } : {});

/**
 * ADR-0029: a resource the caller may not see is reported as missing, so the API cannot be
 * used to enumerate ids. The true reason is preserved for logs.
 */
export const notFound = (resource: string, internalReason?: string) =>
  new AppError(ErrorCode.RESOURCE_NOT_FOUND, {
    detail: `${resource} not found`,
    ...(internalReason !== undefined ? { internalReason } : {}),
  });

export const conflict = (code: ErrorCode, detail?: string) =>
  new AppError(code, detail !== undefined ? { detail } : {});

export const validationFailed = (errors: FieldError[], detail?: string) =>
  new AppError(ErrorCode.VALIDATION_FAILED, {
    errors,
    detail: detail ?? 'One or more fields are invalid',
  });

export const internal = (detail: string, cause?: unknown) =>
  new AppError(ErrorCode.SYSTEM_INTERNAL_ERROR, { detail, cause });
