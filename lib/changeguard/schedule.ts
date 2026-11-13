/**
 * The post-release monitoring schedule (R-30). Pure: every time is on the business clock
 * (app_clock), the clock released_at is on, so a test or the demo moves one clock for all of it.
 *
 *   release ──► slot 1 (release + 1 day) ──► slot 2 ──► … ──► slot 14 (release + 14 days) ──► ended
 *
 * A slot is overdue when the business clock passes it by OVERDUE_AFTER_MS with no conclusion
 * recorded (the worker is not running, or every attempt errored).
 */

const HOUR = 3_600_000;

export const CHECK_EVERY_MS = 24 * HOUR;
export const WINDOW_MS = 14 * 24 * HOUR;
export const OVERDUE_AFTER_MS = 6 * HOUR;
/** After a check errors, the same slot is tried again this much later. */
export const RETRY_AFTER_MS = HOUR;

export function firstSchedule(releasedAt: Date): { dueAt: Date; until: Date } {
  return { dueAt: new Date(releasedAt.getTime() + CHECK_EVERY_MS), until: new Date(releasedAt.getTime() + WINDOW_MS) };
}

/**
 * The slot after `slot`, skipping slots the clock has already passed: a check that runs late
 * covers everything since the release, so missed slots are reported, not replayed one by one.
 * Null once the next slot would fall after the window.
 */
export function nextSlot(slot: Date, now: Date, until: Date | null): { next: Date | null; missed: number } {
  let next = slot.getTime() + CHECK_EVERY_MS;
  let missed = 0;
  while (next <= now.getTime()) {
    next += CHECK_EVERY_MS;
    missed++;
  }
  return { next: until && next > until.getTime() ? null : new Date(next), missed };
}

export function isOverdue(dueAt: Date | string | null, now: Date): boolean {
  return dueAt !== null && now.getTime() > new Date(dueAt).getTime() + OVERDUE_AFTER_MS;
}
