import jwt from 'jsonwebtoken'
import request from 'supertest'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '../src/db/client'
import { signToken } from '../src/middleware/auth'
import { app, authed, initDb, resetDb, signup } from './helpers'

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

  it('rejects a properly signed token the account has revoked', async () => {
    const { userId } = await signup()
    db.prepare('UPDATE users SET token_version = 3 WHERE id = ?').run(userId)

    const res = await authed(signToken(userId, 2)).get('/api/me')

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'session expired' })
  })

  it('accepts a token with no tv claim, as read at version 0', async () => {
    const { userId } = await signup()

    // What every token issued before the claim existed looks like.
    const res = await authed(jwtWithoutTv(userId)).get('/api/me')

    expect(res.status).toBe(200)
  })
})

/** A token in the pre-token_version shape: `sub` and nothing else. */
function jwtWithoutTv(userId: string): string {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET!, {
    expiresIn: '30d',
  })
}

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
