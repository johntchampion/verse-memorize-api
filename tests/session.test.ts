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

    const res = await authed(token)
      .post('/api/attempt')
      .send({
        userVerseId: otherUserVerseId,
        exerciseType: 'tile_fill_blank',
        correct: true,
      })
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'user_verse not found' })
  })

  it('404s for a random uuid', async () => {
    const { token } = await signup()
    const res = await authed(token)
      .post('/api/attempt')
      .send({
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

    const badId = await authed(token)
      .post('/api/attempt')
      .send({ userVerseId: 'not-a-uuid', exerciseType: 'tile_fill_blank', correct: true })
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
