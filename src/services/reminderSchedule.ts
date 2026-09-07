import { reminderMinute } from '../domain/reminder'
import {
  addDays,
  instantForLocalTime,
  minuteOfDayInTimezone,
  todayInTimezone,
} from '../lib/dates'
import * as attempts from '../repositories/attemptRepository'

/**
 * Bounding the anchor query matters because attempts are never pruned: without
 * a floor the MAX walks a year-old account's whole history every day. Ninety
 * days is also right on its own terms — someone quiet that long has no habitual
 * time left to aim at.
 */
const LOOKBACK_DAYS = 90

/**
 * Holding the date rather than a timestamp means an entry evicts itself when the
 * day rolls over, so the map stays bounded by user count rather than uptime.
 */
const dueCache = new Map<string, { date: string; dueMs: number }>()

/** Module state, so tests that move the clock start from a clean map. */
export function clearDueCache(): void {
  dueCache.clear()
}

/** A user who changes timezone mid-day keeps a stale value until midnight,
    which at worst puts one reminder off by the offset delta. */
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
 * The first attempt of the most recent *prior* day they attempted anything —
 * prior, so today's own practice never moves today's reminder.
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
