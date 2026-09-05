import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { authed, initDb, resetDb, signup } from './helpers'

beforeAll(() => {
  initDb()
})

beforeEach(() => {
  resetDb()
})

describe('GET /api/session/today', () => {
  it('builds exercises only for the active (slotted) verses, repeated', async () => {
    const { token } = await signup()
    const res = await authed(token).get('/api/session/today')

    expect(res.status).toBe(200)
    expect(res.body.translation).toBe('WEB')
    expect(res.body.count).toBe(res.body.exercises.length)
    expect(res.body.exercises.length).toBeGreaterThan(0)

    const verseIds = new Set(
      res.body.exercises.map((e: { verseId: string }) => e.verseId),
    )
    const activeIds = new Set(
      (await authed(token).get('/api/verses')).body.verses
        .filter((v: { status: string }) => v.status === 'active')
        .map((v: { id: string }) => v.id),
    )
    expect(verseIds).toEqual(activeIds)

    for (const exercise of res.body.exercises) {
      expect(exercise.queue).toBe('learning')
      expect(exercise.stage).toBe('learning_light')
      expect(typeof exercise.userVerseId).toBe('string')
    }

    // Each active verse repeats more than once within the session.
    const counts = new Map<string, number>()
    for (const e of res.body.exercises) {
      counts.set(e.verseId, (counts.get(e.verseId) ?? 0) + 1)
    }
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(1)
    }
  })

  it('rejects an unknown ?translation=', async () => {
    const { token } = await signup()
    const res = await authed(token).get('/api/session/today?translation=XXX')
    expect(res.status).toBe(400)
  })
})

describe('POST /api/attempt', () => {
  async function firstActiveUserVerseId(token: string): Promise<string> {
    const me = await authed(token).get('/api/me')
    return me.body.slots.active[0].userVerseId
  }

  it('advances a tier after 3 consecutive correct attempts', async () => {
    const { token } = await signup()
    const userVerseId = await firstActiveUserVerseId(token)

    let last
    for (let i = 0; i < 3; i += 1) {
      last = await authed(token)
        .post('/api/attempt')
        .send({ userVerseId, exerciseType: 'tile_fill_blank', correct: true })
      expect(last.status).toBe(200)
    }
    expect(last!.body.userVerse.stage).toBe('learning_medium')
    expect(last!.body.graduated).toBe(false)
  })

  it('caps tier changes at one per day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))

    const { token } = await signup({ timezone: 'UTC' })
    const userVerseId = await firstActiveUserVerseId(token)
    const attempt = (correct: boolean) =>
      authed(token)
        .post('/api/attempt')
        .send({ userVerseId, exerciseType: 'tile_fill_blank', correct })

    for (let i = 0; i < 3; i += 1) await attempt(true) // -> learning_medium
    let last
    for (let i = 0; i < 3; i += 1) last = await attempt(true) // another 3 correct, same day
    expect(last!.body.userVerse.stage).toBe('learning_medium') // still capped
  })

  it('rejects a userVerseId that does not belong to this user', async () => {
    const { token } = await signup()
    const other = await signup()
    const otherUserVerseId = await firstActiveUserVerseId(other.token)

    const res = await authed(token).post('/api/attempt').send({
      userVerseId: otherUserVerseId,
      exerciseType: 'tile_fill_blank',
      correct: true,
    })
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'user_verse not found' })
  })

  it('404s for a random uuid', async () => {
    const { token } = await signup()
    const res = await authed(token).post('/api/attempt').send({
      userVerseId: '00000000-0000-0000-0000-000000000000',
      exerciseType: 'tile_fill_blank',
      correct: true,
    })
    expect(res.status).toBe(404)
  })

  it('rejects an invalid body', async () => {
    const { token } = await signup()
    const userVerseId = await firstActiveUserVerseId(token)

    const badType = await authed(token)
      .post('/api/attempt')
      .send({ userVerseId, exerciseType: 'not_a_type', correct: true })
    expect(badType.status).toBe(400)

    const badCorrect = await authed(token)
      .post('/api/attempt')
      .send({ userVerseId, exerciseType: 'tile_fill_blank', correct: 'yes' })
    expect(badCorrect.status).toBe(400)

    const badId = await authed(token).post('/api/attempt').send({
      userVerseId: 'not-a-uuid',
      exerciseType: 'tile_fill_blank',
      correct: true,
    })
    expect(badId.status).toBe(400)
  })

  it('graduates learning_heavy -> review, freeing and refilling the slot', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let day = new Date('2026-01-01T00:00:00Z')
    vi.setSystemTime(day)

    const { token } = await signup({ timezone: 'UTC' })
    const userVerseId = await firstActiveUserVerseId(token)
    const attempt = (correct: boolean) =>
      authed(token)
        .post('/api/attempt')
        .send({ userVerseId, exerciseType: 'tile_fill_blank', correct })

    // learning_light -> learning_medium -> learning_heavy -> review, one
    // upgrade allowed per day.
    let last
    for (let step = 0; step < 3; step += 1) {
      for (let i = 0; i < 3; i += 1) last = await attempt(true)
      day = new Date(day.getTime() + 24 * 60 * 60 * 1000)
      vi.setSystemTime(day)
    }

    expect(last!.body.userVerse.stage).toBe('review')
    expect(last!.body.graduated).toBe(true)
    expect(last!.body.userVerse.slot).toBeNull()
    // The freed slot is refilled in the same transaction as the graduating attempt.
    expect(last!.body.slotsFilled.length).toBeGreaterThan(0)
  })
})

describe('POST /api/session/complete', () => {
  it('records the first completion of the day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))

    const { token } = await signup({ timezone: 'UTC' })
    const res = await authed(token).post('/api/session/complete').send()

    expect(res.status).toBe(200)
    expect(res.body.recorded).toBe(true)
    expect(res.body.sessionsCompleted).toBe(1)
  })

  it('is idempotent within the same day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))

    const { token } = await signup({ timezone: 'UTC' })
    await authed(token).post('/api/session/complete').send()
    const second = await authed(token).post('/api/session/complete').send()

    expect(second.body.recorded).toBe(false)
    expect(second.body.sessionsCompleted).toBe(1)
  })

  it('records again on a later day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))

    const { token } = await signup({ timezone: 'UTC' })
    await authed(token).post('/api/session/complete').send()

    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'))
    const res = await authed(token).post('/api/session/complete').send()

    expect(res.body.recorded).toBe(true)
    expect(res.body.sessionsCompleted).toBe(2)
  })
})

describe('GET /api/session/today (resuming a session)', () => {
  interface WireExercise {
    verseId: string
    userVerseId: string
    queue: string
    stage: string
    completed: boolean
    blankedText: string
    wordBank: string[]
    userVerse: Record<string, unknown>
  }

  /** Identity and order of the queue, ignoring which words got blanked. */
  const order = (body: { exercises: WireExercise[] }) =>
    body.exercises.map((e) => `${e.verseId}|${e.queue}`)

  const attempt = (token: string, userVerseId: string, correct = true) =>
    authed(token)
      .post('/api/attempt')
      .send({ userVerseId, exerciseType: 'tile_fill_blank', correct })

  it('returns the same queue on repeated calls', async () => {
    const { token } = await signup()
    const first = await authed(token).get('/api/session/today')
    const second = await authed(token).get('/api/session/today')

    expect(second.body.count).toBe(first.body.count)
    expect(order(second.body)).toEqual(order(first.body))
    expect(first.body.practice).toBe(false)
    expect(first.body.completedCount).toBe(0)
    expect(first.body.exercises.every((e: WireExercise) => !e.completed)).toBe(
      true,
    )
  })

  it('marks answered exercises done without reshuffling the queue', async () => {
    const { token } = await signup()
    const before = await authed(token).get('/api/session/today')
    const userVerseId = before.body.exercises[0].userVerseId

    await attempt(token, userVerseId)
    const after = await authed(token).get('/api/session/today')

    expect(after.body.count).toBe(before.body.count)
    expect(order(after.body)).toEqual(order(before.body))
    expect(after.body.completedCount).toBe(1)
    expect(after.body.exercises[0].completed).toBe(true)
  })

  it('ticks off a verse repetition at a time, in order', async () => {
    const { token } = await signup()
    const before = await authed(token).get('/api/session/today')
    const userVerseId = before.body.exercises[0].userVerseId

    await attempt(token, userVerseId)
    await attempt(token, userVerseId)
    const after = await authed(token).get('/api/session/today')

    const forVerse = after.body.exercises.filter(
      (e: WireExercise) => e.userVerseId === userVerseId,
    )
    expect(forVerse.map((e: WireExercise) => e.completed)).toEqual([
      true,
      true,
      false,
    ])
    expect(after.body.completedCount).toBe(2)
  })

  it('carries each verse’s progress alongside the exercise', async () => {
    const { token } = await signup()
    const res = await authed(token).get('/api/session/today')

    for (const exercise of res.body.exercises as WireExercise[]) {
      expect(exercise.userVerse.id).toBe(exercise.userVerseId)
      expect(exercise.userVerse.verse_id).toBe(exercise.verseId)
      expect(exercise.userVerse.stage).toBe(exercise.stage)
      // The v1 snake_case shape, same as POST /api/attempt returns.
      expect(typeof exercise.userVerse.consecutive_correct).toBe('number')
      expect(typeof exercise.userVerse.needs_relearning).toBe('number')
    }
  })

  it('starts a fresh queue the next day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))

    const { token } = await signup({ timezone: 'UTC' })
    const first = await authed(token).get('/api/session/today')
    await attempt(token, first.body.exercises[0].userVerseId)
    expect(
      (await authed(token).get('/api/session/today')).body.completedCount,
    ).toBe(1)

    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'))
    const nextDay = await authed(token).get('/api/session/today')

    expect(nextDay.body.count).toBe(first.body.count)
    expect(nextDay.body.completedCount).toBe(0)
  })

  it('keeps an answered review verse in the day’s queue', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let day = new Date('2026-01-01T00:00:00Z')
    vi.setSystemTime(day)

    const { token } = await signup({ timezone: 'UTC' })
    const me = await authed(token).get('/api/me')
    const userVerseId = me.body.slots.active[0].userVerseId

    // learning_light -> medium -> heavy -> review, one upgrade per day. The
    // verse graduates on day 3 with a 1-day interval, so it is due on day 4.
    for (let step = 0; step < 3; step += 1) {
      for (let i = 0; i < 3; i += 1) await attempt(token, userVerseId)
      day = new Date(day.getTime() + 24 * 60 * 60 * 1000)
      vi.setSystemTime(day)
    }

    const due = await authed(token).get('/api/session/today')
    const scheduled = due.body.exercises.filter(
      (e: WireExercise) => e.userVerseId === userVerseId,
    )
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0].queue).toBe('review')

    // Answering pushes due_at into the future; the exercise must stay put,
    // marked done, rather than disappearing from the queue.
    await attempt(token, userVerseId)
    const after = await authed(token).get('/api/session/today')
    const stillThere = after.body.exercises.filter(
      (e: WireExercise) => e.userVerseId === userVerseId,
    )

    expect(after.body.count).toBe(due.body.count)
    expect(order(after.body)).toEqual(order(due.body))
    expect(stillThere).toHaveLength(1)
    expect(stillThere[0].completed).toBe(true)
  })

  it('appends a mid-session slot refill to the end of the queue', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let day = new Date('2026-01-01T00:00:00Z')
    vi.setSystemTime(day)

    const { token } = await signup({ timezone: 'UTC' })
    const me = await authed(token).get('/api/me')
    const userVerseId = me.body.slots.active[0].userVerseId

    // Two days of upgrades leaves the verse at learning_heavy, one run short
    // of graduating.
    for (let step = 0; step < 2; step += 1) {
      for (let i = 0; i < 3; i += 1) await attempt(token, userVerseId)
      day = new Date(day.getTime() + 24 * 60 * 60 * 1000)
      vi.setSystemTime(day)
    }

    const before = await authed(token).get('/api/session/today')
    const knownVerses = new Set(
      before.body.exercises.map((e: WireExercise) => e.verseId),
    )

    let graduating
    for (let i = 0; i < 3; i += 1)
      graduating = await attempt(token, userVerseId)
    expect(graduating!.body.graduated).toBe(true)

    const after = await authed(token).get('/api/session/today')
    const tail = after.body.exercises.slice(before.body.count)

    expect(order(after.body).slice(0, before.body.count)).toEqual(
      order(before.body),
    )
    expect(tail).toHaveLength(3)
    const refilled = new Set(tail.map((e: WireExercise) => e.verseId))
    expect(refilled.size).toBe(1)
    expect(knownVerses.has([...refilled][0])).toBe(false)
  })
})

describe('GET /api/session/today?practice=true', () => {
  /** Blanks and tile order together — enough to tell two drills apart. */
  const shape = (body: {
    exercises: { blankedText: string; wordBank: string[] }[]
  }) => body.exercises.map((e) => `${e.blankedText}::${e.wordBank.join(',')}`)

  it('returns one exercise per slotted verse, in slot order', async () => {
    const { token } = await signup()
    const res = await authed(token).get('/api/session/today?practice=true')
    const me = await authed(token).get('/api/me')

    expect(res.status).toBe(200)
    expect(res.body.practice).toBe(true)
    expect(res.body.count).toBe(me.body.slots.active.length)
    expect(res.body.completedCount).toBe(0)
    expect(
      res.body.exercises.map((e: { verseId: string }) => e.verseId),
    ).toEqual(me.body.slots.active.map((s: { verseId: string }) => s.verseId))

    for (const exercise of res.body.exercises) {
      expect(exercise.completed).toBe(false)
      expect(exercise.queue).toBe('learning')
      expect(exercise.userVerse.id).toBe(exercise.userVerseId)
    }
  })

  it('blanks different words each time it is called', async () => {
    const { token } = await signup()
    const first = await authed(token).get('/api/session/today?practice=true')
    const second = await authed(token).get('/api/session/today?practice=true')

    expect(shape(second.body)).not.toEqual(shape(first.body))
  })

  it('leaves the day’s session untouched', async () => {
    const { token } = await signup()
    const expected = await authed(token).get('/api/session/today')

    await authed(token).get('/api/session/today?practice=true')
    await authed(token).get('/api/session/today?practice=true')
    const after = await authed(token).get('/api/session/today')

    expect(after.body.count).toBe(expected.body.count)
    expect(after.body.completedCount).toBe(0)
  })

  it('accepts ?practice=1 and ignores other values', async () => {
    const { token } = await signup()
    const on = await authed(token).get('/api/session/today?practice=1')
    const off = await authed(token).get('/api/session/today?practice=nope')

    expect(on.body.practice).toBe(true)
    expect(off.body.practice).toBe(false)
    expect(off.body.count).toBeGreaterThan(on.body.count)
  })
})

describe('review interval progression', () => {
  const attempt = (token: string, userVerseId: string, correct = true) =>
    authed(token)
      .post('/api/attempt')
      .send({ userVerseId, exerciseType: 'tile_fill_blank', correct })

  /**
   * Drives a fresh verse up the learning ladder into review. Returns its id
   * with the clock parked on the day it first comes due, on a 1-day interval.
   */
  async function verseDueForReview(token: string, start: Date) {
    let day = start
    vi.setSystemTime(day)
    const me = await authed(token).get('/api/me')
    const userVerseId = me.body.slots.active[0].userVerseId

    // One tier per day: light -> medium -> heavy -> review.
    for (let step = 0; step < 3; step += 1) {
      for (let i = 0; i < 3; i += 1) await attempt(token, userVerseId)
      day = new Date(day.getTime() + 24 * 60 * 60 * 1000)
      vi.setSystemTime(day)
    }
    return { userVerseId, day }
  }

  it('does not step the interval for repeats on the same day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { token } = await signup({ timezone: 'UTC' })
    const { userVerseId } = await verseDueForReview(
      token,
      new Date('2026-01-01T00:00:00Z'),
    )

    // Three correct answers, all on the verse's single due date. Under the
    // interval ladder three correct reviews step 1 day -> 3 days; done inside
    // one day they must not.
    let last
    for (let i = 0; i < 3; i += 1) last = await attempt(token, userVerseId)

    expect(last!.body.userVerse.stage).toBe('review')
    expect(last!.body.userVerse.interval_days).toBe(1)
    expect(last!.body.userVerse.due_at).toBe('2026-01-05')
    // Only the first of the three counted.
    expect(last!.body.userVerse.consecutive_correct).toBe(1)
  })

  it('steps the interval once the three due dates are actually met', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { token } = await signup({ timezone: 'UTC' })
    let { userVerseId, day } = await verseDueForReview(
      token,
      new Date('2026-01-01T00:00:00Z'),
    )

    // Day one of review: answer it several times, then once a day after that.
    for (let i = 0; i < 3; i += 1) await attempt(token, userVerseId)

    let last
    for (let i = 0; i < 2; i += 1) {
      day = new Date(day.getTime() + 24 * 60 * 60 * 1000)
      vi.setSystemTime(day)
      last = await attempt(token, userVerseId)
    }

    expect(last!.body.userVerse.interval_days).toBe(3)
    expect(last!.body.userVerse.due_at).toBe('2026-01-09')
    expect(last!.body.userVerse.consecutive_correct).toBe(0)
  })

  it('does not let a mid-session graduation collect review credit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let day = new Date('2026-01-01T00:00:00Z')
    vi.setSystemTime(day)

    const { token } = await signup({ timezone: 'UTC' })
    const me = await authed(token).get('/api/me')
    const userVerseId = me.body.slots.active[0].userVerseId

    for (let step = 0; step < 2; step += 1) {
      for (let i = 0; i < 3; i += 1) await attempt(token, userVerseId)
      day = new Date(day.getTime() + 24 * 60 * 60 * 1000)
      vi.setSystemTime(day)
    }

    // The third answer graduates it; the two after it are the repetitions
    // still sitting in today's queue behind the graduating one.
    for (let i = 0; i < 3; i += 1) await attempt(token, userVerseId)
    const graduated = await attempt(token, userVerseId)
    const trailing = await attempt(token, userVerseId)

    expect(graduated.body.userVerse.stage).toBe('review')
    expect(trailing.body.userVerse.consecutive_correct).toBe(0)
    expect(trailing.body.userVerse.interval_days).toBe(1)
    expect(trailing.body.userVerse.due_at).toBe('2026-01-04')
  })
})

describe('session events (recapping a resumed session)', () => {
  interface EventBody {
    kind: string
    reference: string
    verseId: string
    stageFrom: string | null
    stageTo: string | null
    slot: number | null
  }

  async function firstActiveUserVerseId(token: string): Promise<string> {
    const me = await authed(token).get('/api/me')
    return me.body.slots.active[0].userVerseId
  }

  function attempt(token: string, userVerseId: string, correct: boolean) {
    return authed(token)
      .post('/api/attempt')
      .send({ userVerseId, exerciseType: 'tile_fill_blank', correct })
  }

  it('serves an upgrade back to a session that was quit and resumed', async () => {
    const { token } = await signup()
    const userVerseId = await firstActiveUserVerseId(token)

    let last
    for (let i = 0; i < 3; i += 1)
      last = await attempt(token, userVerseId, true)
    expect(last!.body.userVerse.stage).toBe('learning_medium')

    // The upgrade came back on the attempt that caused it...
    expect(last!.body.events.map((e: EventBody) => e.kind)).toEqual(['tier_up'])

    // ...and is still there for a client that comes back later holding none of
    // it in memory. This is the bug: the recap used to know only the sitting it
    // was open for.
    const resumed = await authed(token).get('/api/session/today')
    const events = resumed.body.events as EventBody[]
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'tier_up',
      stageFrom: 'learning_light',
      stageTo: 'learning_medium',
    })
    expect(typeof events[0].reference).toBe('string')
    expect(events[0].reference.length).toBeGreaterThan(0)
  })

  it('does not repeat an upgrade on the verse’s remaining repetitions', async () => {
    const { token } = await signup()
    const userVerseId = await firstActiveUserVerseId(token)

    for (let i = 0; i < 3; i += 1) await attempt(token, userVerseId, true)

    // A learning verse is drilled 3 times a day; the client used to compare
    // against the stage it cached at load, so these re-reported the same move.
    // The tier-per-day cap means nothing actually happens here.
    const fourth = await attempt(token, userVerseId, true)
    const fifth = await attempt(token, userVerseId, true)
    expect(fourth.body.events).toEqual([])
    expect(fifth.body.events).toEqual([])

    const resumed = await authed(token).get('/api/session/today')
    expect(resumed.body.events).toHaveLength(1)
  })

  it('reports a graduation and the slot it freed, without double-counting', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let day = new Date('2026-01-01T00:00:00Z')
    vi.setSystemTime(day)

    const { token } = await signup({ timezone: 'UTC' })
    const userVerseId = await firstActiveUserVerseId(token)

    let last
    for (let step = 0; step < 3; step += 1) {
      for (let i = 0; i < 3; i += 1) {
        last = await attempt(token, userVerseId, true)
      }
      day = new Date(day.getTime() + 24 * 60 * 60 * 1000)
      vi.setSystemTime(day)
    }

    const events = last!.body.events as EventBody[]
    expect(events.map((e) => e.kind)).toEqual(['graduated', 'slot_filled'])

    // The graduating verse is reported once, as the graduation. The slot event
    // belongs to whatever moved in behind it.
    expect(events[0].verseId).not.toBe(events[1].verseId)
    // A slot event names its verse now, rather than only the slot number.
    expect(events[1].reference.length).toBeGreaterThan(0)
    expect(events[1].slot).toBe(last!.body.slotsFilled[0].slot)

    vi.useRealTimers()
  })

  it('counts the day’s correct answers across a resume', async () => {
    const { token } = await signup()
    const start = await authed(token).get('/api/session/today')
    expect(start.body.correctCount).toBe(0)

    const [first, second, third] = start.body.exercises
    await attempt(token, first.userVerseId, true)
    await attempt(token, second.userVerseId, false)
    await attempt(token, third.userVerseId, true)

    const resumed = await authed(token).get('/api/session/today')
    expect(resumed.body.completedCount).toBe(3)
    expect(resumed.body.correctCount).toBe(2)
  })

  it('keeps a practice drill’s recap to itself', async () => {
    const { token } = await signup()
    const userVerseId = await firstActiveUserVerseId(token)
    for (let i = 0; i < 3; i += 1) await attempt(token, userVerseId, true)

    // The day has an event, and the day's session reports it.
    expect((await authed(token).get('/api/session/today')).body.events).toEqual(
      [expect.objectContaining({ kind: 'tier_up' })],
    )

    // A drill is separate work: it recaps what it moves, not what the day did.
    const drill = await authed(token).get('/api/session/today?practice=true')
    expect(drill.body.events).toEqual([])
    expect(drill.body.correctCount).toBe(0)
  })

  it('reports the slots session/complete tops up', async () => {
    const { token } = await signup()
    const done = await authed(token).post('/api/session/complete')

    expect(done.status).toBe(200)
    // Signup already filled every slot, so a normal completion moves nothing.
    expect(done.body.events).toEqual([])
    expect(done.body.slotsFilled).toEqual([])
  })
})
