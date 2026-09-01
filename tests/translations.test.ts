import request from 'supertest'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { app, authed, initDb, resetDb, signup } from './helpers'

beforeAll(() => {
  initDb()
})

beforeEach(() => {
  resetDb()
})

describe('GET /api/translations', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/api/translations')
    expect(res.status).toBe(401)
  })

  it('lists every catalog translation with the WEB default', async () => {
    const { token } = await signup()
    const res = await authed(token).get('/api/translations')

    expect(res.status).toBe(200)
    expect(res.body.default).toBe('WEB')
    expect(Array.isArray(res.body.translations)).toBe(true)

    const codes = res.body.translations.map((t: { code: string }) => t.code)
    expect(codes).toContain('WEB')
    expect(new Set(codes).size).toBe(codes.length) // no duplicates

    for (const t of res.body.translations) {
      expect(t).toEqual(
        expect.objectContaining({
          code: expect.any(String),
          name: expect.any(String),
          license: expect.any(String),
        }),
      )
    }
  })
})
