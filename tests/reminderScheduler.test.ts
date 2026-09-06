import { randomUUID } from 'node:crypto'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '../src/db/client'
import type { PushSubscriptionRow } from '../src/db/client'
import { instantForLocalTime } from '../src/lib/dates'
import type { SendResult } from '../src/services/pushSender'
import {
  clearDueCache,
  runReminderTick,
} from '../src/services/reminderScheduler'
import { initDb, resetDb } from './helpers'

beforeAll(initDb)
beforeEach(() => {
  resetDb()
  // The due-instant memo is module state, so a test that moves the clock has
  // to start from an empty one.
  clearDueCache()
})

const CHICAGO = 'America/Chicago'

interface TestUser {
  id: string
  timezone: string
  userVerseId: string
}

function createUser(
  options: {
    timezone?: string
    remindersEnabled?: boolean
    subscriptions?: number
  } = {},
): TestUser {
  const {
    timezone = CHICAGO,
    remindersEnabled = true,
    subscriptions = 1,
  } = options
  const id = randomUUID()
  const userVerseId = randomUUID()

  db.prepare(
    `INSERT INTO users (id, email, password_hash, created_at, timezone, reminders_enabled)
     VALUES (?, ?, 'h', '2020-01-01T00:00:00Z', ?, ?)`,
  ).run(id, `${id}@example.com`, timezone, remindersEnabled ? 1 : 0)

  db.prepare(
    `INSERT INTO user_verse (id, user_id, verse_id, stage, activated_at)
     VALUES (?, ?, 'john-3-16', 'learning_light', '2020-01-01T00:00:00Z')`,
  ).run(userVerseId, id)

  for (let i = 0; i < subscriptions; i += 1) {
    db.prepare(
      `INSERT INTO push_subscription (id, user_id, endpoint, p256dh, auth, created_at)
       VALUES (?, ?, ?, 'p', 'a', '2020-01-01T00:00:00Z')`,
    ).run(randomUUID(), id, `https://push.example/${id}/${i}`)
  }

  return { id, timezone, userVerseId }
}

/** An attempt at a local time of day on a local date. */
function attemptAt(user: TestUser, date: string, minuteOfDay: number): void {
  db.prepare(
    `INSERT INTO attempt (id, user_verse_id, exercise_type, correct, created_at)
     VALUES (?, ?, 'tile_fill_blank', 1, ?)`,
  ).run(
    randomUUID(),
    user.userVerseId,
    instantForLocalTime(user.timezone, date, minuteOfDay).toISOString(),
  )
}

function completedSessionOn(user: TestUser, date: string): void {
  db.prepare(
    'INSERT INTO session_log (id, user_id, completed_at) VALUES (?, ?, ?)',
  ).run(
    randomUUID(),
    user.id,
    instantForLocalTime(user.timezone, date, 12 * 60).toISOString(),
  )
}

function lastSentDate(userId: string): string | null {
  const row = db
    .prepare('SELECT reminder_last_sent_date FROM users WHERE id = ?')
    .get(userId) as { reminder_last_sent_date: string | null }
  return row.reminder_last_sent_date
}

function endpointsFor(userId: string): string[] {
  return (
    db
      .prepare('SELECT endpoint FROM push_subscription WHERE user_id = ?')
      .all(userId) as { endpoint: string }[]
  ).map((row) => row.endpoint)
}

/** Runs a tick at a local wall-clock time, collecting what got sent. */
async function tickAt(
  timezone: string,
  date: string,
  minuteOfDay: number,
  send?: (subscription: PushSubscriptionRow) => Promise<SendResult>,
): Promise<string[]> {
  const delivered: string[] = []
  await runReminderTick({
    now: () => instantForLocalTime(timezone, date, minuteOfDay),
    send: async (subscription) => {
      delivered.push(subscription.endpoint)
      return send ? await send(subscription) : 'sent'
    },
  })
  return delivered
}

const TODAY = '2026-01-15'

describe('the default 9pm reminder', () => {
  it('does not fire before 21:00 local', async () => {
    createUser()
    expect(await tickAt(CHICAGO, TODAY, 20 * 60 + 59)).toEqual([])
  })

  it('fires at 21:00 local', async () => {
    const user = createUser()

    const sent = await tickAt(CHICAGO, TODAY, 21 * 60)

    expect(sent).toEqual([`https://push.example/${user.id}/0`])
    expect(lastSentDate(user.id)).toBe(TODAY)
  })

  it('fires once, not once a minute', async () => {
    const user = createUser()

    await tickAt(CHICAGO, TODAY, 21 * 60)
    const second = await tickAt(CHICAGO, TODAY, 21 * 60 + 1)

    expect(second).toEqual([])
    expect(lastSentDate(user.id)).toBe(TODAY)
  })

  // Two users, one instant, two different local dates: any confusion between
  // UTC and local fails loudly here.
  it('is 21:00 in each user’s own zone', async () => {
    const auckland = createUser({ timezone: 'Pacific/Auckland' })
    const losAngeles = createUser({ timezone: 'America/Los_Angeles' })

    // 21:00 in Auckland on the 15th is 08:00 on the 14th in Los Angeles.
    const sent = await tickAt('Pacific/Auckland', TODAY, 21 * 60)

    expect(sent).toEqual([`https://push.example/${auckland.id}/0`])
    expect(lastSentDate(losAngeles.id)).toBeNull()
  })
})

describe('the anchor', () => {
  it('is 30 minutes after yesterday’s first attempt', async () => {
    const user = createUser()
    attemptAt(user, '2026-01-14', 8 * 60)
    attemptAt(user, '2026-01-14', 9 * 60)

    expect(await tickAt(CHICAGO, TODAY, 8 * 60 + 29)).toEqual([])
    expect(await tickAt(CHICAGO, TODAY, 8 * 60 + 30)).toHaveLength(1)
    expect(lastSentDate(user.id)).toBe(TODAY)
  })

  it('walks back past days with no attempts', async () => {
    const user = createUser()
    attemptAt(user, '2026-01-11', 7 * 60)

    const sent = await tickAt(CHICAGO, TODAY, 7 * 60 + 30)

    expect(sent).toHaveLength(1)
    expect(lastSentDate(user.id)).toBe(TODAY)
  })

  // 20:50 + 30 would be 21:20, which is past the cap.
  it('is capped at 21:00', async () => {
    const user = createUser()
    attemptAt(user, '2026-01-14', 20 * 60 + 50)

    expect(await tickAt(CHICAGO, TODAY, 20 * 60 + 59)).toEqual([])
    expect(await tickAt(CHICAGO, TODAY, 21 * 60)).toHaveLength(1)
  })

  // Nothing in the lookback window is the same as nothing at all: no habit
  // left to aim at, so it falls through to the 21:00 default.
  it('ignores attempts older than the lookback window', async () => {
    const user = createUser()
    attemptAt(user, '2025-09-01', 7 * 60)

    expect(await tickAt(CHICAGO, TODAY, 7 * 60 + 30)).toEqual([])
    expect(await tickAt(CHICAGO, TODAY, 21 * 60)).toHaveLength(1)
  })

  // Prior day, deliberately: practising this morning must not move this
  // evening's reminder.
  it('ignores today’s own attempts', async () => {
    const user = createUser()
    attemptAt(user, TODAY, 6 * 60)

    expect(await tickAt(CHICAGO, TODAY, 6 * 60 + 30)).toEqual([])
    expect(await tickAt(CHICAGO, TODAY, 21 * 60)).toHaveLength(1)
  })
})

describe('suppression', () => {
  it('does not remind someone who already finished today', async () => {
    const user = createUser()
    completedSessionOn(user, TODAY)

    const sent = await tickAt(CHICAGO, TODAY, 21 * 60)

    expect(sent).toEqual([])
    // Claimed anyway, so the suppression queries don't repeat every minute
    // until midnight.
    expect(lastSentDate(user.id)).toBe(TODAY)
  })

  it('stops re-evaluating a completed day', async () => {
    const user = createUser()
    completedSessionOn(user, TODAY)
    await tickAt(CHICAGO, TODAY, 21 * 60)

    const second = await tickAt(CHICAGO, TODAY, 21 * 60 + 5, async () => {
      throw new Error('should not have been reached')
    })

    expect(second).toEqual([])
  })

  it('does not interrupt someone mid-session', async () => {
    const user = createUser()
    attemptAt(user, TODAY, 20 * 60 + 50)

    const sent = await tickAt(CHICAGO, TODAY, 21 * 60)

    expect(sent).toEqual([])
    // Not claimed: they may stop without finishing, and the reminder re-arms.
    expect(lastSentDate(user.id)).toBeNull()
  })

  it('re-arms once they have been idle for 30 minutes', async () => {
    const user = createUser()
    attemptAt(user, TODAY, 20 * 60 + 50)
    await tickAt(CHICAGO, TODAY, 21 * 60)

    const sent = await tickAt(CHICAGO, TODAY, 21 * 60 + 25)

    expect(sent).toHaveLength(1)
    expect(lastSentDate(user.id)).toBe(TODAY)
  })
})

describe('the catch-up window', () => {
  it('still sends a reminder the process was down for', async () => {
    const user = createUser()

    const sent = await tickAt(CHICAGO, TODAY, 22 * 60 + 30)

    expect(sent).toHaveLength(1)
    expect(lastSentDate(user.id)).toBe(TODAY)
  })

  it('gives up rather than delivering a stale one', async () => {
    const user = createUser()

    const sent = await tickAt(CHICAGO, TODAY, 23 * 60 + 30)

    expect(sent).toEqual([])
    expect(lastSentDate(user.id)).toBeNull()
  })
})

describe('who is a candidate', () => {
  it('skips users who have not opted in', async () => {
    const user = createUser({ remindersEnabled: false })

    expect(await tickAt(CHICAGO, TODAY, 21 * 60)).toEqual([])
    expect(lastSentDate(user.id)).toBeNull()
  })

  it('skips users with no registered device', async () => {
    const user = createUser({ subscriptions: 0 })

    expect(await tickAt(CHICAGO, TODAY, 21 * 60)).toEqual([])
    expect(lastSentDate(user.id)).toBeNull()
  })
})

describe('fanning out to devices', () => {
  it('sends to every device but claims the day once', async () => {
    const user = createUser({ subscriptions: 2 })

    const sent = await tickAt(CHICAGO, TODAY, 21 * 60)

    expect(sent).toHaveLength(2)
    expect(lastSentDate(user.id)).toBe(TODAY)
  })

  it('deletes an endpoint the push service reports as gone', async () => {
    const user = createUser({ subscriptions: 2 })
    const dead = `https://push.example/${user.id}/0`

    await tickAt(CHICAGO, TODAY, 21 * 60, async (subscription) =>
      subscription.endpoint === dead ? 'gone' : 'sent',
    )

    expect(endpointsFor(user.id)).toEqual([`https://push.example/${user.id}/1`])
  })

  it('keeps an endpoint that merely failed', async () => {
    const user = createUser({ subscriptions: 2 })

    await tickAt(CHICAGO, TODAY, 21 * 60, async () => 'failed')

    expect(endpointsFor(user.id)).toHaveLength(2)
  })

  it('reports what happened', async () => {
    const user = createUser({ subscriptions: 3 })
    const endpoints = endpointsFor(user.id)

    const summary = await runReminderTick({
      now: () => instantForLocalTime(CHICAGO, TODAY, 21 * 60),
      send: async (subscription) => {
        if (subscription.endpoint === endpoints[0]) return 'gone'
        if (subscription.endpoint === endpoints[1]) return 'failed'
        return 'sent'
      },
    })

    expect(summary).toMatchObject({
      considered: 1,
      sent: 1,
      removed: 1,
      failed: 1,
      verdicts: { send: 1 },
    })
  })
})
