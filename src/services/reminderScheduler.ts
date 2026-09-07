/**
 * The daily practice reminder: who is due, and sending it to them.
 *
 * A ticker inside the web process rather than a cron job or a queue, because
 * the deployment is one container over one SQLite file and adding a scheduler
 * to that would be more moving parts than the job needs. It does mean the
 * reminder is best-effort — see "catch-up" below, and the README.
 *
 * Cheap on purpose. Every minute it reads one filtered scan of `users`, and
 * for almost all of them the answer is a string compare against a column
 * already in hand. The queries that actually cost something — the anchor
 * lookup in `attempt`, and the suppression checks — run once per enabled user
 * per local day, in the minute their reminder comes due.
 */
import type { PushSubscriptionRow } from '../db/client'
import * as attempts from '../repositories/attemptRepository'
import * as sessionLogs from '../repositories/sessionLogRepository'
import * as users from '../repositories/userRepository'
import type { ReminderCandidateRow } from '../repositories/userRepository'
import {
  reminderMinute,
  reminderVerdict,
  type ReminderVerdict,
} from '../domain/reminder'
import {
  addDays,
  instantForLocalTime,
  minuteOfDayInTimezone,
  todayInTimezone,
} from '../lib/dates'
import {
  DAILY_REMINDER,
  sendToSubscription,
  sendToUser,
  type ReminderPayload,
  type SendResult,
} from './pushSender'

/** The due time is a minute-resolution concept: finer just burns wakeups,
    coarser makes reminders visibly late. */
const TICK_MS = 60_000

/**
 * How late a missed reminder may still go out.
 *
 * Two hours covers a deploy or a restart. It deliberately does not cover an
 * overnight outage — a 21:00 reminder delivered at 07:00 is worse than none.
 * Nothing stale survives the night anyway: the next tick falls on a new local
 * date, the due instant is recomputed for that date, and it is in the future.
 */
const CATCH_UP_MS = 2 * 60 * 60 * 1000

/** An attempt more recent than this means they are practising right now. */
const MID_SESSION_MS = 30 * 60 * 1000

/**
 * How far back to look for a habit to anchor to.
 *
 * Bounding the anchor query matters because attempts are never pruned: without
 * a floor the MAX walks a year-old account's entire history every day. Ninety
 * days is also the right answer on its own terms — someone who hasn't
 * practised since then has no habitual time left to aim at, so they fall
 * through to the 21:00 default.
 */
const LOOKBACK_DAYS = 90

export interface ReminderPorts {
  now: () => Date
  /**
   * Delivers one payload to one subscription. Injected so tests never touch
   * the network and never have to mock the web-push module.
   */
  send: (
    subscription: PushSubscriptionRow,
    payload: ReminderPayload,
  ) => Promise<SendResult>
}

export interface TickSummary {
  considered: number
  sent: number
  removed: number
  failed: number
  verdicts: Partial<Record<ReminderVerdict, number>>
}

type Candidate = ReminderCandidateRow

/** True when a session_log row already exists for the user's local `today`. */
function completedOn(userId: string, timezone: string, today: string): boolean {
  return sessionLogs
    .recentForUser(userId)
    .some(
      (row) => todayInTimezone(timezone, new Date(row.completed_at)) === today,
    )
}

/**
 * Claims today's reminder for a user, atomically.
 *
 * Committed before any network I/O, and conditional so that two overlapping
 * ticks cannot both win. Claim-before-send means a crash between the claim and
 * the send loses that day's reminder; send-then-record would instead re-send
 * on restart, and a user who gets the same nudge three times from a
 * crash-looping container turns the feature off and never turns it back on.
 * Losing a day is the cheaper failure.
 */
function claim(userId: string, today: string): boolean {
  return users.claimReminderDay(userId, today)
}

/**
 * userId -> the due instant already worked out for a given local date.
 *
 * Holding the date rather than a timestamp means the entry evicts itself when
 * the day rolls over, so the map stays bounded by user count rather than by
 * uptime, and the `attempt` queries run once per user per day instead of once
 * a minute.
 */
const dueCache = new Map<string, { date: string; dueMs: number }>()

/** Module state, so tests that move the clock start from a clean map. */
export function clearDueCache(): void {
  dueCache.clear()
}

/**
 * When today's reminder is due for this user, as epoch millis.
 *
 * The anchor is the first attempt of the most recent *prior* day they
 * attempted anything — prior, so that today's own practice never moves today's
 * reminder. A user who changes timezone mid-day keeps a stale value until
 * midnight, which at worst puts one reminder off by the offset delta.
 */
function dueInstantFor(
  userId: string,
  timezone: string,
  today: string,
): number {
  const cached = dueCache.get(userId)
  if (cached?.date === today) return cached.dueMs

  const startOfToday = instantForLocalTime(timezone, today, 0).toISOString()
  const floor = instantForLocalTime(
    timezone,
    addDays(today, -LOOKBACK_DAYS),
    0,
  ).toISOString()

  let anchorMinute: number | null = null
  const mostRecent = attempts.lastAttemptBefore(userId, {
    since: floor,
    before: startOfToday,
  })
  if (mostRecent) {
    // The most recent prior attempt identifies the anchor day; the first
    // attempt *on* that day is the time of day worth aiming at.
    const anchorDay = todayInTimezone(timezone, new Date(mostRecent))
    const firstOfDay = attempts.firstAttemptBetween(
      userId,
      instantForLocalTime(timezone, anchorDay, 0).toISOString(),
      instantForLocalTime(timezone, addDays(anchorDay, 1), 0).toISOString(),
    )
    if (firstOfDay) {
      anchorMinute = minuteOfDayInTimezone(timezone, new Date(firstOfDay))
    }
  }

  const dueMs = instantForLocalTime(
    timezone,
    today,
    reminderMinute(anchorMinute),
  ).getTime()
  dueCache.set(userId, { date: today, dueMs })
  return dueMs
}

/** One pass over everyone who has opted in. */
export async function runReminderTick(
  ports: Partial<ReminderPorts> = {},
): Promise<TickSummary> {
  const now = ports.now?.() ?? new Date()
  const send = ports.send ?? sendToSubscription
  const nowMs = now.getTime()

  const summary: TickSummary = {
    considered: 0,
    sent: 0,
    removed: 0,
    failed: 0,
    verdicts: {},
  }

  for (const user of users.reminderCandidates()) {
    summary.considered += 1
    const today = todayInTimezone(user.timezone, now)

    // The whole reason a tick is cheap: for all but one minute of their day,
    // an opted-in user is dismissed by a string compare on a column already
    // in hand.
    if (user.reminder_last_sent_date === today) continue

    const dueMs = dueInstantFor(user.id, user.timezone, today)

    // Both database-touching inputs are deferred past the two checks that
    // don't need them, so they run once per user per day rather than per tick.
    let verdict = reminderVerdict({
      nowMs,
      dueMs,
      catchUpMs: CATCH_UP_MS,
      completedToday: false,
      lastAttemptMs: null,
      midSessionMs: MID_SESSION_MS,
    })

    if (verdict === 'send') {
      const midSessionSince = new Date(nowMs - MID_SESSION_MS).toISOString()
      const lastAttempt = attempts.lastAttemptSince(user.id, midSessionSince)
      verdict = reminderVerdict({
        nowMs,
        dueMs,
        catchUpMs: CATCH_UP_MS,
        completedToday: completedOn(user.id, user.timezone, today),
        lastAttemptMs: lastAttempt ? new Date(lastAttempt).getTime() : null,
        midSessionMs: MID_SESSION_MS,
      })
    }

    summary.verdicts[verdict] = (summary.verdicts[verdict] ?? 0) + 1

    // Nothing more is owed today, and claiming stops these queries repeating
    // every minute until midnight.
    if (verdict === 'completed') {
      claim(user.id, today)
      continue
    }

    // Skipped *without* claiming: they may stop without finishing, in which
    // case the reminder re-arms 30 minutes after their last attempt. The
    // catch-up window bounds how long that can go on.
    if (verdict !== 'send') continue

    if (!claim(user.id, today)) continue

    const result = await sendToUser(user.id, DAILY_REMINDER, send)
    summary.sent += result.sent
    summary.removed += result.removed
    summary.failed += result.failed
  }

  return summary
}

let timer: NodeJS.Timeout | null = null
let ticking = false

/**
 * setInterval does not await, so a slow tick could otherwise overlap the next
 * one. The claim would still stop a double send, but the overlap would double
 * the query load for nothing.
 */
async function tickGuarded(ports: Partial<ReminderPorts>): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    await runReminderTick(ports)
  } catch (err) {
    // Never let one bad tick take the interval down with it.
    console.error('reminder tick failed', err)
  } finally {
    ticking = false
  }
}

export function startReminderScheduler(
  ports: Partial<ReminderPorts> = {},
): void {
  if (timer) return
  timer = setInterval(() => void tickGuarded(ports), TICK_MS)
  // The HTTP listener is what keeps the process alive; this shouldn't be.
  timer.unref()
}

export function stopReminderScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
}
