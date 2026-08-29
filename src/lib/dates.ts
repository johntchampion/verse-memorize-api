/**
 * Date-only helpers. `user_verse.due_at` and the session-completion
 * idempotency check are both calendar-day concepts evaluated in the user's
 * timezone, never wall-clock instants.
 */

/** `YYYY-MM-DD` for "now" as seen in `timezone`. */
export function todayInTimezone(timezone: string, now = new Date()): string {
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    // Unknown timezone on the user row — fall back to UTC rather than 500.
    return now.toISOString().slice(0, 10);
  }
}

/** Adds `days` to a `YYYY-MM-DD` string, returning the same format. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
