/** Working out when a user's reminder is due, and remembering the answer. */
import { reminderMinute } from '../domain/reminder'
import {
  addDays,
  instantForLocalTime,
  minuteOfDayInTimezone,
  todayInTimezone,
} from '../lib/dates'
import * as attempts from '../repositories/attemptRepository'

/**
 * How far back to look for a habit to anchor to.
 *
 * Bounding the anchor query matters because attempts are never pruned: without
 * a floor the MAX walks a year-old account's entire history every day. Ninety
 * days is also right on its own terms — someone who hasn't practised since then
 * has no habitual time left to aim at, so they fall through to the 21:00
 * default.
 */
const LOOKBACK_DAYS = 90

/**
 * userId -> the due instant already worked out for a given local date.
 *
 * Holding the date rather than a timestamp means the entry evicts itself when
 * the day rolls over, so the map stays bounded by user count rather than by
 * uptime, and the `attempt` queries run once per user per day instead of once a
 * minute.
 */
const dueCache = new Map<string, { date: string; dueMs: number }>()

/** Module state, so tests that move the clock start from a clean map. */
export function clearDueCache(): void {
  dueCache.clear()
}

/**
 * When today's reminder is due for this user, as epoch millis.
 *
 * A user who changes timezone mid-day keeps a stale value until midnight, which
 * at worst puts one reminder off by the offset delta.
 */
export function dueInstantFor(
  userId: string,
  timezone: string,
  today: string,
): number {
  const cached = dueCache.get(userId)
  if (cached?.date === today) return cached.dueMs

  const dueMs = instantForLocalTime(
    timezone,
    today,
    reminderMinute(anchorMinuteFor(userId, timezone, today)),
  ).getTime()
  dueCache.set(userId, { date: today, dueMs })
  return dueMs
}

/**
 * The minute of day worth aiming at: the first attempt of the most recent
 * *prior* day they attempted anything — prior, so today's own practice never
 * moves today's reminder. Null when there is no habit to anchor to.
 */
function anchorMinuteFor(
  userId: string,
  timezone: string,
  today: string,
): number | null {
  const startOfToday = instantForLocalTime(timezone, today, 0).toISOString()
  const floor = instantForLocalTime(
    timezone,
    addDays(today, -LOOKBACK_DAYS),
    0,
  ).toISOString()

  const mostRecent = attempts.lastAttemptBefore(userId, {
    since: floor,
    before: startOfToday,
  })
  if (!mostRecent) return null

  const anchorDay = todayInTimezone(timezone, new Date(mostRecent))
  const firstOfDay = attempts.firstAttemptBetween(
    userId,
    instantForLocalTime(timezone, anchorDay, 0).toISOString(),
    instantForLocalTime(timezone, addDays(anchorDay, 1), 0).toISOString(),
  )
  if (!firstOfDay) return null

  return minuteOfDayInTimezone(timezone, new Date(firstOfDay))
}
