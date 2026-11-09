/**
 * Typed connector failures. The job runner decides retry vs. fail from the TYPE alone, so a
 * transport detail (status code, header, message wording) is interpreted exactly once, in the
 * client, and never re-parsed downstream.
 *
 *   AuthError         401/403 or a success:false auth message. Never retried: repeating a
 *                     rejected key does not fix it and can get the key locked.
 *   RateLimitError    429. Retried after Retry-After when the server sends one, else backoff.
 *   TimeoutError      no response within the client's timeout. Retried.
 *   UnavailableError  5xx or a network failure. Retried.
 *   ProtocolError     the response is not what the contract says (ignored params, foreign
 *                     office data, unparseable envelope). Not retried: it needs a person.
 *   BadRecordError    one record is unusable; the rest of its batch continues. Carried as a
 *                     value in GetResult.rejected, never thrown for a whole request.
 */

export type ConnectorErrorKind = "auth" | "rate_limit" | "timeout" | "unavailable" | "protocol" | "bad_record";

export abstract class ConnectorError extends Error {
  abstract readonly kind: ConnectorErrorKind;
  abstract readonly retryable: boolean;
  constructor(
    message: string,
    /** HTTP status when there was a response. */
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class AuthError extends ConnectorError {
  readonly kind = "auth" as const;
  readonly retryable = false;
}

export class RateLimitError extends ConnectorError {
  readonly kind = "rate_limit" as const;
  readonly retryable = true;
  constructor(
    message: string,
    status: number | null,
    /** From Retry-After when present. FieldRoutes does not document the header (research/17 §5). */
    readonly retryAfterMs: number | null,
  ) {
    super(message, status);
  }
}

export class TimeoutError extends ConnectorError {
  readonly kind = "timeout" as const;
  readonly retryable = true;
}

export class UnavailableError extends ConnectorError {
  readonly kind = "unavailable" as const;
  readonly retryable = true;
}

export class ProtocolError extends ConnectorError {
  readonly kind = "protocol" as const;
  readonly retryable = false;
}

export class BadRecordError extends ConnectorError {
  readonly kind = "bad_record" as const;
  readonly retryable = false;
  constructor(
    message: string,
    /** The record's id when it could be read. */
    readonly recordId: string | null,
  ) {
    super(message, null);
  }
}

export function isConnectorError(error: unknown): error is ConnectorError {
  return error instanceof ConnectorError;
}
