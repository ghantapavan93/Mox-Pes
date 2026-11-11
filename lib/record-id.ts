/**
 * A database id taken from a URL (a path segment or query value), parsed once, the same way at
 * every boundary.
 *
 * Canonical decimal only: 1 to 15 digits, no leading zero. Fifteen digits keep the value exact
 * as a JS number and inside Postgres `bigint`. `Number.isInteger(Number(raw))` is not enough:
 * it accepts "1e3", " 12" and "99999999999999999999" (1e20), and the last one reached Postgres
 * as an out-of-range bigint and crashed the incident page behind an HTTP 200 (hardening pass,
 * docs/testing.md).
 */
const RECORD_ID = /^[1-9]\d{0,14}$/;

export function parseRecordId(raw: string | null | undefined): number | null {
  return raw !== null && raw !== undefined && RECORD_ID.test(raw) ? Number(raw) : null;
}
