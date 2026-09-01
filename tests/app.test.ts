import request from 'supertest'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { app, initDb, resetDb } from './helpers'

beforeAll(() => {
  initDb()
})

beforeEach(() => {
  resetDb()
})

describe('GET /health', () => {
  it('reports ok without auth', async () => {
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })
})

describe('unknown routes', () => {
  it('404s', async () => {
    const res = await request(app).get('/nope')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not found' })
  })
})

describe('auth middleware', () => {
  it('rejects a protected route with no Authorization header', async () => {
    const res = await request(app).get('/api/me')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'missing bearer token' })
  })

  it('rejects a header that is not a Bearer token', async () => {
    const res = await request(app)
      .get('/api/me')
      .set('Authorization', 'Basic dXNlcjpwYXNz')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'missing bearer token' })
  })

  it('rejects a garbage bearer token', async () => {
    const res = await request(app)
      .get('/api/me')
      .set('Authorization', 'Bearer not-a-real-token')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'invalid token' })
  })
})

describe('malformed request bodies', () => {
  it('returns 500 for unparseable JSON (current body-parser error handling)', async () => {
    const res = await request(app)
      .post('/auth/signup')
      .set('Content-Type', 'application/json')
      .send('{not valid json')
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'internal error' })
  })
})
