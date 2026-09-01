import request from 'supertest'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { app, authed, initDb, resetDb, signup, uniqueEmail } from './helpers'

beforeAll(() => {
  initDb()
})

beforeEach(() => {
  resetDb()
})

describe('POST /auth/signup', () => {
  it('creates a user and returns a usable token', async () => {
    const email = uniqueEmail()
    const res = await request(app)
      .post('/auth/signup')
      .send({ email, password: 'password123' })

    expect(res.status).toBe(201)
    expect(typeof res.body.token).toBe('string')
    expect(typeof res.body.userId).toBe('string')

    const me = await authed(res.body.token).get('/api/me')
    expect(me.status).toBe(200)
    expect(me.body.user.email).toBe(email)
  })

  it('defaults timezone to UTC and translation to WEB', async () => {
    const { token } = await signup()
    const me = await authed(token).get('/api/me')
    expect(me.body.user.timezone).toBe('UTC')
    expect(me.body.user.translation).toBe('WEB')
  })

  it('accepts an explicit timezone and translation', async () => {
    const { token } = await signup({
      timezone: 'America/Chicago',
      translation: 'kjv',
    })
    const me = await authed(token).get('/api/me')
    expect(me.body.user.timezone).toBe('America/Chicago')
    expect(me.body.user.translation).toBe('KJV')
  })

  it('fills all 3 slots at signup', async () => {
    // refillSlots tops up every empty slot from the queue in one pass, so a
    // brand-new account starts with all 3 slots occupied, not a ramp-up.
    const { token } = await signup()
    const me = await authed(token).get('/api/me')
    expect(me.body.slots.max).toBe(3)
    expect(me.body.slots.active).toHaveLength(3)
    expect(me.body.slots.active.map((s: { slot: number }) => s.slot)).toEqual([
      1, 2, 3,
    ])
    expect(me.body.versesStarted).toBe(3)
  })

  it('rejects a short password', async () => {
    const res = await request(app)
      .post('/auth/signup')
      .send({ email: uniqueEmail(), password: 'short' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid body')
    expect(res.body.details).toBeDefined()
  })

  it('rejects an invalid email', async () => {
    const res = await request(app)
      .post('/auth/signup')
      .send({ email: 'not-an-email', password: 'password123' })
    expect(res.status).toBe(400)
  })

  it('rejects an unknown translation code', async () => {
    const res = await request(app).post('/auth/signup').send({
      email: uniqueEmail(),
      password: 'password123',
      translation: 'XXX',
    })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'unknown translation' })
  })

  it('rejects a duplicate email, case-insensitively', async () => {
    const email = uniqueEmail()
    const first = await request(app)
      .post('/auth/signup')
      .send({ email, password: 'password123' })
    expect(first.status).toBe(201)

    const second = await request(app)
      .post('/auth/signup')
      .send({ email: email.toUpperCase(), password: 'password123' })
    expect(second.status).toBe(409)
    expect(second.body).toEqual({ error: 'email already registered' })
  })
})

describe('POST /auth/login', () => {
  it('logs in with correct credentials', async () => {
    const email = uniqueEmail()
    const password = 'password123'
    await request(app).post('/auth/signup').send({ email, password })

    const res = await request(app).post('/auth/login').send({ email, password })
    expect(res.status).toBe(200)
    expect(typeof res.body.token).toBe('string')
    expect(typeof res.body.userId).toBe('string')
  })

  it('rejects a wrong password', async () => {
    const email = uniqueEmail()
    await request(app)
      .post('/auth/signup')
      .send({ email, password: 'password123' })

    const res = await request(app)
      .post('/auth/login')
      .send({ email, password: 'wrongpassword' })
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'invalid credentials' })
  })

  it('rejects an unknown email with the same shape as a wrong password', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: uniqueEmail(), password: 'password123' })
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'invalid credentials' })
  })

  it('rejects an invalid body', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'nope' })
    expect(res.status).toBe(400)
  })
})
