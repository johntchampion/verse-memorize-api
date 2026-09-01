import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { authed, initDb, resetDb, signup } from './helpers'

beforeAll(() => {
  initDb()
})

beforeEach(() => {
  resetDb()
})

/** A theme id that's real in src/data/themes.ts, used as a queue-reorder fixture. */
const THEME_ID = 'trinity'

describe('GET /api/queue', () => {
  it('excludes the slotted verses from a fresh signup', async () => {
    const { token } = await signup()
    const verses = (await authed(token).get('/api/verses')).body.verses
    const slottedIds = new Set(
      verses
        .filter((v: { status: string }) => v.status === 'active')
        .map((v: { id: string }) => v.id),
    )

    const res = await authed(token).get('/api/queue')
    expect(res.status).toBe(200)
    expect(res.body.customized).toBe(false)
    const queueIds = res.body.queue.map((v: { id: string }) => v.id)
    expect(queueIds.length).toBeGreaterThan(0)
    for (const id of slottedIds) {
      expect(queueIds).not.toContain(id)
    }
  })

  it('rejects an unknown ?translation=', async () => {
    const { token } = await signup()
    const res = await authed(token).get('/api/queue?translation=XXX')
    expect(res.status).toBe(400)
  })
})

describe('PUT /api/queue', () => {
  it('stores a custom order that GET reflects afterward', async () => {
    const { token } = await signup()
    const current = (await authed(token).get('/api/queue')).body.queue.map(
      (v: { id: string }) => v.id,
    )
    const reordered = [...current].reverse()

    const put = await authed(token).put('/api/queue').send({ verseIds: reordered })
    expect(put.status).toBe(200)
    expect(put.body.customized).toBe(true)
    expect(put.body.queue.map((v: { id: string }) => v.id)).toEqual(reordered)

    const get = await authed(token).get('/api/queue')
    expect(get.body.customized).toBe(true)
    expect(get.body.queue.map((v: { id: string }) => v.id)).toEqual(reordered)
  })

  it('rejects an empty array', async () => {
    const { token } = await signup()
    const res = await authed(token).put('/api/queue').send({ verseIds: [] })
    expect(res.status).toBe(400)
  })

  it('rejects an unknown verse id', async () => {
    const { token } = await signup()
    const res = await authed(token)
      .put('/api/queue')
      .send({ verseIds: ['not-a-real-verse'] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/unknown verse id/)
  })

  it('rejects a duplicate verse id', async () => {
    const { token } = await signup()
    const current = (await authed(token).get('/api/queue')).body.queue.map(
      (v: { id: string }) => v.id,
    )
    const res = await authed(token)
      .put('/api/queue')
      .send({ verseIds: [current[0], current[0]] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/duplicate verse id/)
  })
})

describe('DELETE /api/queue', () => {
  it('reverts to the default order', async () => {
    const { token } = await signup()
    const defaultOrder = (await authed(token).get('/api/queue')).body.queue.map(
      (v: { id: string }) => v.id,
    )
    await authed(token)
      .put('/api/queue')
      .send({ verseIds: [...defaultOrder].reverse() })

    const del = await authed(token).delete('/api/queue')
    expect(del.status).toBe(200)
    expect(del.body.customized).toBe(false)
    expect(del.body.queue.map((v: { id: string }) => v.id)).toEqual(defaultOrder)
  })
})

describe('POST /api/queue/theme', () => {
  it('moves a theme’s queued verses to the front', async () => {
    const { token } = await signup()
    const res = await authed(token)
      .post('/api/queue/theme')
      .send({ themeId: THEME_ID })
    expect(res.status).toBe(200)
    expect(res.body.customized).toBe(true)

    const queueIds: string[] = res.body.queue.map((v: { id: string }) => v.id)
    const themeIds: string[] = res.body.queue
      .filter((v: { themeIds: string[] }) => v.themeIds.includes(THEME_ID))
      .map((v: { id: string }) => v.id)
    expect(themeIds.length).toBeGreaterThan(0)
    expect(queueIds.slice(0, themeIds.length).sort()).toEqual(
      [...themeIds].sort(),
    )
  })

  it('rejects an unknown theme id', async () => {
    const { token } = await signup()
    const res = await authed(token)
      .post('/api/queue/theme')
      .send({ themeId: 'not-a-real-theme' })
    expect(res.status).toBe(400)
  })

  it('rejects a missing themeId', async () => {
    const { token } = await signup()
    const res = await authed(token).post('/api/queue/theme').send({})
    expect(res.status).toBe(400)
  })
})

describe('POST /api/queue/next', () => {
  it('moves a queued verse to the front', async () => {
    const { token } = await signup()
    const queue = (await authed(token).get('/api/queue')).body.queue
    const target = queue[queue.length - 1].id

    const res = await authed(token).post('/api/queue/next').send({ verseId: target })
    expect(res.status).toBe(200)
    expect(res.body.queue[0].id).toBe(target)
  })

  it('rejects a verse that is not in the queue', async () => {
    const { token } = await signup()
    const verses = (await authed(token).get('/api/verses')).body.verses
    const slotted = verses.find((v: { status: string }) => v.status === 'active')

    const res = await authed(token)
      .post('/api/queue/next')
      .send({ verseId: slotted.id })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'verse is not in the queue' })
  })
})

describe('POST /api/slots/replace', () => {
  it('places a queued verse into a slot and displaces the previous occupant to the front of the queue', async () => {
    const { token } = await signup()
    const verses = (await authed(token).get('/api/verses')).body.verses
    const previousOccupant = verses.find(
      (v: { slot: number | null }) => v.slot === 1,
    )
    const incoming = (await authed(token).get('/api/queue')).body.queue[0]

    const res = await authed(token)
      .post('/api/slots/replace')
      .send({ verseId: incoming.id, slot: 1 })
    expect(res.status).toBe(200)
    expect(res.body.placed.slot).toBe(1)
    expect(res.body.placed.verse_id).toBe(incoming.id)
    expect(res.body.displaced.verse_id).toBe(previousOccupant.id)
    expect(res.body.displaced.slot).toBeNull()
    expect(res.body.queue[0].id).toBe(previousOccupant.id)
  })

  it('rejects an out-of-range slot', async () => {
    const { token } = await signup()
    const incoming = (await authed(token).get('/api/queue')).body.queue[0]
    const res = await authed(token)
      .post('/api/slots/replace')
      .send({ verseId: incoming.id, slot: 4 })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'no such slot' })
  })

  it('404s for an unknown verse id', async () => {
    const { token } = await signup()
    const res = await authed(token)
      .post('/api/slots/replace')
      .send({ verseId: 'not-a-real-verse', slot: 1 })
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'verse not found' })
  })

  it('rejects a verse that is already slotted', async () => {
    const { token } = await signup()
    const verses = (await authed(token).get('/api/verses')).body.verses
    const alreadySlotted = verses.find(
      (v: { slot: number | null }) => v.slot === 2,
    )

    const res = await authed(token)
      .post('/api/slots/replace')
      .send({ verseId: alreadySlotted.id, slot: 1 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/not available for practice/)
  })
})

describe('relearning re-enters at the front of the queue', () => {
  /**
   * Graduates a slotted verse (learning_heavy -> review), then fails it
   * REVIEW_DEMOTION_THRESHOLD (2) times in a row so it drops into relearning.
   * Each tier advance is capped at one per day, so this steps through
   * simulated days. Returns the verse id that ends up in relearning.
   */
  async function driveIntoRelearning(token: string): Promise<string> {
    const verses = (await authed(token).get('/api/verses')).body.verses
    const verseId = verses.find(
      (v: { status: string }) => v.status === 'active',
    ).id
    const userVerseId = (await authed(token).get('/api/me')).body.slots.active.find(
      (s: { verseId: string }) => s.verseId === verseId,
    ).userVerseId

    const attempt = (correct: boolean) =>
      authed(token)
        .post('/api/attempt')
        .send({ userVerseId, exerciseType: 'tile_fill_blank', correct })

    let day = new Date('2026-01-01T12:00:00Z')
    // learning_light -> learning_medium -> learning_heavy -> review, one
    // upgrade per day, three corrects per upgrade.
    for (let stageStep = 0; stageStep < 3; stageStep += 1) {
      vi.setSystemTime(day)
      for (let i = 0; i < 3; i += 1) await attempt(true)
      day = new Date(day.getTime() + 24 * 60 * 60 * 1000)
    }

    const graduated = (await authed(token).get('/api/verses/' + verseId)).body
    expect(graduated.status).toBe('review')

    // Two consecutive misses in review demote it into relearning.
    vi.setSystemTime(day)
    await attempt(false)
    day = new Date(day.getTime() + 24 * 60 * 60 * 1000)
    vi.setSystemTime(day)
    await attempt(false)

    const relearning = (await authed(token).get('/api/verses/' + verseId)).body
    expect(relearning.userVerse.needs_relearning).toBe(1)

    return verseId
  }

  it('surfaces at the front of the default queue', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { token } = await signup({ timezone: 'UTC' })

    const verseId = await driveIntoRelearning(token)

    const queue = await authed(token).get('/api/queue')
    expect(queue.body.customized).toBe(false)
    expect(queue.body.queue[0].id).toBe(verseId)
    expect(queue.body.queue[0].relearning).toBe(true)
  })

  it('surfaces at the front of a customized queue, then behaves like an ordinary entry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { token } = await signup({ timezone: 'UTC' })

    // Custom-order the queue with the eventual relearner buried in the middle.
    const before = (await authed(token).get('/api/queue')).body.queue.map(
      (v: { id: string }) => v.id,
    )
    const midpoint = Math.floor(before.length / 2)
    const custom = [...before]
    // Nothing to move yet — the relearner isn't queued (it's slotted) until
    // driveIntoRelearning finishes, so just fix an arbitrary custom order now.
    await authed(token).put('/api/queue').send({ verseIds: custom })
    expect(midpoint).toBeGreaterThanOrEqual(0)

    const verseId = await driveIntoRelearning(token)

    const afterRelearning = await authed(token).get('/api/queue')
    expect(afterRelearning.body.customized).toBe(true)
    expect(afterRelearning.body.queue[0].id).toBe(verseId)
    expect(afterRelearning.body.queue[0].relearning).toBe(true)

    // The bump is one-time: moving a different verse to the front pushes the
    // relearner back like any other ordinary queue member.
    const other = afterRelearning.body.queue.find(
      (v: { id: string }) => v.id !== verseId,
    ).id
    const afterMove = await authed(token)
      .post('/api/queue/next')
      .send({ verseId: other })
    expect(afterMove.body.queue[0].id).toBe(other)
    expect(afterMove.body.queue.map((v: { id: string }) => v.id)).toContain(
      verseId,
    )
  })
})
