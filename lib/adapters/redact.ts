import { hashEmail, hashPhone } from "@/lib/primitives";

/**
 * PII is hashed before anything else touches a payload — before validation, before the
 * raw event log, before projection.
 *
 * Rules
 *   * A whole value shaped like an email, or like a FORMATTED phone number (separators,
 *     parentheses or a +1 prefix), is replaced by a hash token wherever it appears. When a
 *     source moves a phone number to a new field (`customer_phone_number` → `caller.number`),
 *     the mapper of the day does not know the field, but the value is still hashed.
 *   * A bare 10–11 digit string is only treated as a phone when its key says so
 *     (phone/caller/mobile/tel/number). Without that rule, a $1,000–$9,999 Google Ads
 *     `costMicros` value would be "redacted" and the spend lost.
 *   * Phone numbers and emails embedded in free text (agent notes, form messages) are
 *     removed outright, not hashed: nobody needs to join on them.
 *   * Tokens pass through unchanged, so stored payloads stay replayable.
 */

const PHONE_TOKEN = "h:phone:";
const EMAIL_TOKEN = "h:email:";
const FORMATTED_PHONE = /^(\+1[\s.-]?|1[\s.-])?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}$|^\+1\d{10}$|^\(\d{3}\)\s?\d{3}\d{4}$/;
const BARE_PHONE = /^1?\d{10}$/;
const PHONE_KEY = /phone|caller|mobile|\btel\b|number/i;
/** Identifier, money and time fields are never contact details, whatever they look like. */
const NON_CONTACT_KEY = /(^|_)id$|Id$|ID$|account|campaign|date|time|micros|cost|amount|total/i;
/** Fields that hold free text: scrub contact details embedded anywhere in them. */
const FREE_TEXT_KEY = /note|message|text|comment|description/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const EMBEDDED_EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[A-Za-z]{2,}/g;
const EMBEDDED_PHONE = /(\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b|\+?\b1?\d{10}\b/g;

function redactString(raw: string, key: string | undefined): string {
  // Postgres cannot store NUL in text/jsonb; it is never meaningful in source data.
  const value = raw.replace(/\u0000/g, "");
  if (value.startsWith(PHONE_TOKEN) || value.startsWith(EMAIL_TOKEN)) return value;
  if (key !== undefined && NON_CONTACT_KEY.test(key) && !PHONE_KEY.test(key)) return value;
  const trimmed = value.trim();
  if (EMAIL.test(trimmed)) {
    const hashed = hashEmail(trimmed);
    return hashed ? `${EMAIL_TOKEN}${hashed}` : "[email]";
  }
  if (FORMATTED_PHONE.test(trimmed) || (BARE_PHONE.test(trimmed) && key !== undefined && PHONE_KEY.test(key))) {
    const hashed = hashPhone(trimmed);
    if (hashed) return `${PHONE_TOKEN}${hashed}`;
  }
  // Free text only (a sentence, or a known free-text field): never digits-only values.
  const freeText = /\s/.test(trimmed) || (key !== undefined && FREE_TEXT_KEY.test(key));
  return freeText ? value.replace(EMBEDDED_EMAIL, "[email]").replace(EMBEDDED_PHONE, "[phone]") : value;
}

export function redactValue(value: unknown, key?: string): unknown {
  if (typeof value === "string") return redactString(value, key);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactValue(v, k)]));
  }
  return value;
}

/** Hash for a phone field that may already be a redaction token. */
export function phoneHashOf(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  if (value.startsWith(PHONE_TOKEN)) return value.slice(PHONE_TOKEN.length);
  return hashPhone(value);
}

/** Hash for an email field that may already be a redaction token. */
export function emailHashOf(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  if (value.startsWith(EMAIL_TOKEN)) return value.slice(EMAIL_TOKEN.length);
  return hashEmail(value);
}
