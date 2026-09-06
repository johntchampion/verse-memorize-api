/**
 * When the daily practice reminder is due, and whether to actually send it.
 *
 * The rule: nudge half an hour after the time of day the user last actually
 * started practising, so the prompt lands when they are already in the habit of
 * being free — but never later than 21:00, because a reminder that arrives at
 * bedtime is one they will not act on.
 *
 * Pure, like everything in domain/: minutes and millis in, a value out. The
 * user's timezone, the calendar, and what they have actually attempted are the
 * service layer's problem — see services/reminderScheduler.ts. Keeping the Intl
 * work out of here is what lets the timezone tests (many, unpleasant) and the
 * rule tests (a truth table) fail for different reasons.
 */

/** How long after their usual start time the nudge lands. */
export const REMINDER_OFFSET_MINUTES = 30

/** 21:00 local: the latest a reminder is ever sent, and the default. */
export const REMINDER_LATEST_MINUTE = 21 * 60

/**
 * Minutes past local midnight at which today's reminder is due.
 *
 * `anchorMinute` is the local time of day of the first attempt on the most
 * recent prior day the user attempted anything, or null when there is no such
 * day — a brand new account, or one that has been quiet longer than the
 * scheduler looks back, neither of which leaves a habit to anchor to.
 *
 * The cap is what makes this total: without it a 23:50 anchor would push the
 * reminder past midnight and into the wrong day. Anything from 20:30 onwards
 * clamps to 21:00.
 */
export function reminderMinute(anchorMinute: number | null): number {
  if (anchorMinute === null) return REMINDER_LATEST_MINUTE
  return Math.min(
    anchorMinute + REMINDER_OFFSET_MINUTES,
    REMINDER_LATEST_MINUTE,
  )
}

/** Everything the send/skip decision depends on, resolved to plain values. */
export interface ReminderInputs {
  /** Now, as epoch millis. */
  nowMs: number
  /** When today's reminder came due, as epoch millis. */
  dueMs: number
  /** How late a missed reminder may still go out. */
  catchUpMs: number
  /** A session_log row exists for today's local date. */
  completedToday: boolean
  /** The user's most recent attempt as epoch millis, or null. */
  lastAttemptMs: number | null
  /** An attempt more recent than this means they are practising right now. */
  midSessionMs: number
}

export type ReminderVerdict =
  /** Send it. */
  | 'send'
  /** Before the due minute. */
  | 'not-yet'
  /** Past the catch-up window; today is missed. */
  | 'too-late'
  /** They already finished today's session. */
  | 'completed'
  /** They are practising right now; don't interrupt. */
  | 'mid-session'

/**
 * Whether to send, and if not, why not.
 *
 * A verdict rather than a boolean costs nothing and makes both the scheduler's
 * log line and the tests say which rule fired.
 *
 * The order is deliberate: the two checks that need no database work come
 * first, so the caller can compute `completedToday` and `lastAttemptMs` lazily
 * and skip those queries entirely on the ~1439 minutes a day when the answer is
 * simply 'not-yet'.
 */
export function reminderVerdict(input: ReminderInputs): ReminderVerdict {
  if (input.nowMs < input.dueMs) return 'not-yet'
  if (input.nowMs - input.dueMs > input.catchUpMs) return 'too-late'
  if (input.completedToday) return 'completed'
  if (
    input.lastAttemptMs !== null &&
    input.nowMs - input.lastAttemptMs < input.midSessionMs
  ) {
    return 'mid-session'
  }
  return 'send'
}
