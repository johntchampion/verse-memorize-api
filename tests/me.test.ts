import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { authed, initDb, resetDb, signup } from './helpers'

beforeAll(() => {
  initDb()
})

beforeEach(() => {
  resetDb()
})

describe('GET /api/me', () => {
  it('returns the fresh-signup profile shape', async () => {
    const { token } = await signup({ timezone: 'UTC' })
    const res = await authed(token).get('/api/me')

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      streak: 0,
      completedToday: false,
      sessionsCompleted: 0,
      versesStarted: 3,
    })
    expect(res.body.user).toMatchObject({ timezone: 'UTC', translation: 'WEB' })
    expect(res.body.slots.max).toBe(3)
    expect(res.body.slots.active).toHaveLength(3)
    for (const slot of res.body.slots.active) {
      expect(slot).toMatchObject({
        stage: 'learning_light',
        consecutiveCorrect: 0,
        consecutiveIncorrect: 0,
        tierChangeUsedToday: false,
      })
    }
  })

  it('reflects a completed session', async () => {
    const { token } = await signup()
    await authed(token).post('/api/session/complete').send()

    const res = await authed(token).get('/api/me')
    expect(res.body.completedToday).toBe(true)
    expect(res.body.sessionsCompleted).toBe(1)
  })

  it('tracks the streak across simulated days, tolerating an unfinished today', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const day1 = new Date('2026-01-01T12:00:00Z')
    const day2 = new Date('2026-01-02T12:00:00Z')
    const day4 = new Date('2026-01-04T12:00:00Z')

    vi.setSystemTime(day1)
    const { token } = await signup({ timezone: 'UTC' })
    await authed(token).post('/api/session/complete').send()
    expect((await authed(token).get('/api/me')).body.streak).toBe(1)

    vi.setSystemTime(day2)
    const beforeToday = await authed(token).get('/api/me')
    expect(beforeToday.body.completedToday).toBe(false)
    expect(beforeToday.body.streak).toBe(1) // yesterday's streak isn't zeroed by an unfinished today

    await authed(token).post('/api/session/complete').send()
    const afterToday = await authed(token).get('/api/me')
    expect(afterToday.body.completedToday).toBe(true)
    expect(afterToday.body.streak).toBe(2)
    expect(afterToday.body.sessionsCompleted).toBe(2)

    // Skip day 3 entirely, then land on day 4 without completing anything.
    vi.setSystemTime(day4)
    const afterGap = await authed(token).get('/api/me')
    expect(afterGap.body.completedToday).toBe(false)
    expect(afterGap.body.streak).toBe(0)
  })

  it('flags tierChangeUsedToday once a slot advances a tier today', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'))

    const { token } = await signup({ timezone: 'UTC' })
    const before = await authed(token).get('/api/me')
    const userVerseId = before.body.slots.active[0].userVerseId

    for (let i = 0; i < 3; i += 1) {
      await authed(token)
        .post('/api/attempt')
        .send({ userVerseId, exerciseType: 'tile_fill_blank', correct: true })
    }

    const after = await authed(token).get('/api/me')
    const slot = after.body.slots.active.find(
      (s: { userVerseId: string }) => s.userVerseId === userVerseId,
    )
    expect(slot.stage).toBe('learning_medium')
    expect(slot.tierChangeUsedToday).toBe(true)
  })
})

describe('PATCH /api/me', () => {
  it('updates just the timezone', async () => {
    const { token } = await signup()
    const res = await authed(token)
      .patch('/api/me')
      .send({ timezone: 'America/Chicago' })
    expect(res.status).toBe(200)
    expect(res.body.user.timezone).toBe('America/Chicago')
    expect(res.body.user.translation).toBe('WEB')
  })

  it('updates just the translation without touching progress', async () => {
    const { token } = await signup()
    const before = await authed(token).get('/api/me')

    const res = await authed(token)
      .patch('/api/me')
      .send({ translation: 'kjv' })
    expect(res.status).toBe(200)
    expect(res.body.user.translation).toBe('KJV')
    expect(res.body.versesStarted).toBe(before.body.versesStarted)
    expect(res.body.slots.active).toHaveLength(before.body.slots.active.length)
    expect(res.body.streak).toBe(before.body.streak)
  })

  it('updates both fields at once', async () => {
    const { token } = await signup()
    const res = await authed(token)
      .patch('/api/me')
      .send({ timezone: 'America/Chicago', translation: 'esv' })
    expect(res.status).toBe(200)
    expect(res.body.user.timezone).toBe('America/Chicago')
    expect(res.body.user.translation).toBe('ESV')
  })

  it('rejects an empty body', async () => {
    const { token } = await signup()
    const res = await authed(token).patch('/api/me').send({})
    expect(res.status).toBe(400)
  })

  it('rejects an unrecognised timezone', async () => {
    const { token } = await signup()
    const res = await authed(token)
      .patch('/api/me')
      .send({ timezone: 'Not/A_Zone' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'unknown timezone' })
  })

  it('rejects an unrecognised translation', async () => {
    const { token } = await signup()
    const res = await authed(token)
      .patch('/api/me')
      .send({ translation: 'XXX' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'unknown translation' })
  })
})
