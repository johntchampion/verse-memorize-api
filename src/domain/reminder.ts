/** Half an hour after the time of day they last started practising, but never
    later than 21:00: a reminder at bedtime is one they won't act on. */
export const REMINDER_OFFSET_MINUTES = 30
export const REMINDER_LATEST_MINUTE = 21 * 60

/** The cap is what makes this total: without it a 23:50 anchor would push the
    reminder past midnight and into the wrong day. */
export function reminderMinute(anchorMinute: number | null): number {
  if (anchorMinute === null) return REMINDER_LATEST_MINUTE
  return Math.min(
    anchorMinute + REMINDER_OFFSET_MINUTES,
    REMINDER_LATEST_MINUTE,
  )
}

export interface ReminderInputs {
  nowMs: number
  dueMs: number
  catchUpMs: number
  completedToday: boolean
  lastAttemptMs: number | null
  /** An attempt more recent than this means they are practising right now. */
  midSessionMs: number
}

export type ReminderVerdict =
  'send' | 'not-yet' | 'too-late' | 'completed' | 'mid-session'

/**
 * The order is deliberate: the two checks that need no database work come
 * first, so the caller can compute `completedToday` and `lastAttemptMs` lazily
 * and skip those queries on the ~1439 minutes a day answered by 'not-yet'.
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
