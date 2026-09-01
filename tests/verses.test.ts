import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { authed, initDb, resetDb, signup } from './helpers'

beforeAll(() => {
  initDb()
})

beforeEach(() => {
  resetDb()
})

describe('GET /api/verses', () => {
  it('returns the whole bank with per-user status', async () => {
    const { token } = await signup()
    const res = await authed(token).get('/api/verses')

    expect(res.status).toBe(200)
    expect(res.body.translation).toBe('WEB')
    expect(Array.isArray(res.body.verses)).toBe(true)
    expect(res.body.verses.length).toBeGreaterThan(3)

    const active = res.body.verses.filter(
      (v: { status: string }) => v.status === 'active',
    )
    expect(active).toHaveLength(3)
    expect(active.map((v: { slot: number }) => v.slot).sort()).toEqual([
      1, 2, 3,
    ])
    for (const verse of active) {
      expect(verse.stage).toBe('learning_light')
      expect(verse.needsRelearning).toBe(false)
      expect(verse.graduatedAt).toBeNull()
    }

    const untouched = res.body.verses.filter(
      (v: { status: string }) => v.status === 'not_started',
    )
    expect(untouched.length).toBe(res.body.verses.length - 3)
    for (const verse of untouched) {
      expect(verse.stage).toBeNull()
      expect(verse.slot).toBeNull()
    }
  })

  it('canon order is a permutation of the curriculum order', async () => {
    const { token } = await signup()
    const curriculum = await authed(token).get('/api/verses')
    const canon = await authed(token).get('/api/verses?orderBy=canon')

    expect(canon.status).toBe(200)
    const curriculumIds = curriculum.body.verses.map(
      (v: { id: string }) => v.id,
    )
    const canonIds = canon.body.verses.map((v: { id: string }) => v.id)
    expect(new Set(canonIds)).toEqual(new Set(curriculumIds))
    expect(canonIds).not.toEqual(curriculumIds) // genuinely different orderings
  })

  it('honors a ?translation= override without persisting it', async () => {
    const { token } = await signup()
    const overridden = await authed(token).get('/api/verses?translation=kjv')
    expect(overridden.status).toBe(200)
    expect(overridden.body.translation).toBe('KJV')

    const me = await authed(token).get('/api/me')
    expect(me.body.user.translation).toBe('WEB')
  })

  it('rejects an unknown ?translation=', async () => {
    const { token } = await signup()
    const res = await authed(token).get('/api/verses?translation=XXX')
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'unknown translation' })
  })
})

describe('GET /api/verses/:id', () => {
  it('404s for an unknown verse id', async () => {
    const { token } = await signup()
    const res = await authed(token).get('/api/verses/not-a-real-verse')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'verse not found' })
  })

  it('returns full detail for an active (slotted) verse', async () => {
    const { token } = await signup()
    const list = await authed(token).get('/api/verses')
    const active = list.body.verses.find(
      (v: { status: string }) => v.status === 'active',
    )

    const res = await authed(token).get(`/api/verses/${active.id}`)
    expect(res.status).toBe(200)
    expect(res.body.verse.id).toBe(active.id)
    expect(res.body.status).toBe('active')
    expect(res.body.queuePosition).toBeNull() // slotted, not queued
    expect(res.body.userVerse).not.toBeNull()
    expect(res.body.schedule).toBeNull() // learning stages carry no due date
    expect(res.body.history).toEqual({ attempts: [], total: 0, correct: 0 })
    expect(Array.isArray(res.body.themes)).toBe(true)
  })

  it('returns not-started detail for an untouched, queued verse', async () => {
    const { token } = await signup()
    const list = await authed(token).get('/api/verses')
    const untouched = list.body.verses.find(
      (v: { status: string }) => v.status === 'not_started',
    )

    const res = await authed(token).get(`/api/verses/${untouched.id}`)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('not_started')
    expect(res.body.userVerse).toBeNull()
    expect(res.body.schedule).toBeNull()
    expect(res.body.graduatedAt).toBeNull()
    expect(res.body.queuePosition).toBeGreaterThan(0) // untouched verses are queued
    expect(res.body.history).toEqual({ attempts: [], total: 0, correct: 0 })
  })

  it('honors a ?translation= override', async () => {
    const { token } = await signup()
    const list = await authed(token).get('/api/verses')
    const anyVerse = list.body.verses[0]

    const res = await authed(token).get(
      `/api/verses/${anyVerse.id}?translation=kjv`,
    )
    expect(res.status).toBe(200)
    expect(res.body.translation).toBe('KJV')
  })
})
