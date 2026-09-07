import request from 'supertest'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../src/db/client'
import { hashToken } from '../src/lib/tokens'
import type { Email } from '../src/services/mailer'
import { useTransport } from '../src/services/mailer'
import { app, authed, initDb, resetDb, signup } from './helpers'

beforeAll(initDb)

/** Every email the app tried to send during a test, oldest first. */
let outbox: Email[] = []

beforeEach(() => {
  resetDb()
  outbox = []
  useTransport(async (email) => {
    outbox.push(email)
  })
})

/** The token as the email carried it — the only place the raw value exists. */
function tokenFromLastEmail(): string {
  const email = outbox.at(-1)
  if (!email) throw new Error('no email was sent')

  const match = /reset-password\?token=([^"\s]+)/.exec(email.text)
  if (!match) throw new Error(`no reset link in email: ${email.text}`)
  return decodeURIComponent(match[1])
}

function resetRows(): { token_hash: string; used_at: string | null }[] {
  return db.prepare('SELECT token_hash, used_at FROM password_reset').all() as {
    token_hash: string
    used_at: string | null
  }[]
}

describe('POST /auth/forgot-password', () => {
  it('emails a reset link to a registered address', async () => {
    const { email } = await signup()

    const res = await request(app).post('/auth/forgot-password').send({ email })

    expect(res.status).toBe(202)
    expect(res.body).toEqual({ requested: true })
    expect(outbox).toHaveLength(1)
    expect(outbox[0].to).toBe(email)
    expect(outbox[0].subject).toMatch(/reset/i)
  })

  it('answers the same for an address with no account, and sends nothing', async () => {
    const res = await request(app)
      .post('/auth/forgot-password')
      .send({ email: 'nobody@example.com' })

    expect(res.status).toBe(202)
    expect(res.body).toEqual({ requested: true })
    expect(outbox).toHaveLength(0)
    expect(resetRows()).toHaveLength(0)
  })

  it('lowercases the address the way signup and login do', async () => {
    const { email } = await signup()

    // Stored lowercase, and findByEmail is an exact match — without the same
    // normalization this would 202 and quietly send nothing.
    await request(app)
      .post('/auth/forgot-password')
      .send({ email: email.toUpperCase() })

    expect(outbox).toHaveLength(1)
    expect(outbox[0].to).toBe(email)
  })

  it('stores only the hash of the token it emailed', async () => {
    const { email } = await signup()
    await request(app).post('/auth/forgot-password').send({ email })

    const token = tokenFromLastEmail()
    const rows = resetRows()

    expect(rows).toHaveLength(1)
    expect(rows[0].token_hash).toBe(hashToken(token))
    expect(rows[0].token_hash).not.toBe(token)
  })

  it('sends one email per minute however many times it is asked', async () => {
    const { email } = await signup()

    await request(app).post('/auth/forgot-password').send({ email })
    const res = await request(app).post('/auth/forgot-password').send({ email })

    // Still 202: a 429 here would say the address has an account.
    expect(res.status).toBe(202)
    expect(outbox).toHaveLength(1)
  })

  it('rejects a body that is not an email address', async () => {
    const res = await request(app)
      .post('/auth/forgot-password')
      .send({ email: 'not-an-address' })

    expect(res.status).toBe(400)
  })
})

describe('POST /api/me/request-password-reset', () => {
  it('emails the address on the account, with no body', async () => {
    const { token, email } = await signup()

    const res = await authed(token)
      .post('/api/me/request-password-reset')
      .send()

    expect(res.status).toBe(202)
    expect(res.body).toEqual({ requested: true })
    expect(outbox).toHaveLength(1)
    expect(outbox[0].to).toBe(email)
  })

  it('shares the throttle with the public route', async () => {
    const { token, email } = await signup()

    await request(app).post('/auth/forgot-password').send({ email })
    await authed(token).post('/api/me/request-password-reset').send()

    expect(outbox).toHaveLength(1)
  })

  it('requires a bearer token', async () => {
    const res = await request(app).post('/api/me/request-password-reset').send()

    expect(res.status).toBe(401)
  })
})

describe('POST /auth/reset-password', () => {
  async function requestReset(email: string): Promise<string> {
    await request(app).post('/auth/forgot-password').send({ email })
    return tokenFromLastEmail()
  }

  it('sets the new password and signs the caller in', async () => {
    const { email } = await signup({ password: 'oldpassword' })
    const token = await requestReset(email)

    const res = await request(app)
      .post('/auth/reset-password')
      .send({ token, password: 'newpassword' })

    expect(res.status).toBe(200)
    expect(res.body.token).toEqual(expect.any(String))
    expect(res.body.userId).toEqual(expect.any(String))

    // The token it handed back is a live session, not one the bump killed.
    const me = await authed(res.body.token).get('/api/me')
    expect(me.status).toBe(200)
    expect(me.body.user.email).toBe(email)
  })

  it('leaves the old password unusable and the new one working', async () => {
    const { email } = await signup({ password: 'oldpassword' })
    const token = await requestReset(email)

    await request(app)
      .post('/auth/reset-password')
      .send({ token, password: 'newpassword' })

    const stale = await request(app)
      .post('/auth/login')
      .send({ email, password: 'oldpassword' })
    expect(stale.status).toBe(401)

    const fresh = await request(app)
      .post('/auth/login')
      .send({ email, password: 'newpassword' })
    expect(fresh.status).toBe(200)
  })

  it('expires every other session', async () => {
    const { token: sessionA, email } = await signup()
    const sessionB = (
      await request(app)
        .post('/auth/login')
        .send({ email, password: 'password123' })
    ).body.token

    expect((await authed(sessionA).get('/api/me')).status).toBe(200)
    expect((await authed(sessionB).get('/api/me')).status).toBe(200)

    const token = await requestReset(email)
    await request(app)
      .post('/auth/reset-password')
      .send({ token, password: 'newpassword' })

    for (const dead of [sessionA, sessionB]) {
      const res = await authed(dead).get('/api/me')
      expect(res.status).toBe(401)
      expect(res.body).toEqual({ error: 'session expired' })
    }
  })

  it('refuses a token that has already been spent', async () => {
    const { email } = await signup()
    const token = await requestReset(email)

    await request(app)
      .post('/auth/reset-password')
      .send({ token, password: 'newpassword' })

    const res = await request(app)
      .post('/auth/reset-password')
      .send({ token, password: 'newerpassword' })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'reset link is invalid or expired' })
  })

  it('refuses a token past its 30 minutes', async () => {
    const { email } = await signup()
    const token = await requestReset(email)

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.now() + 31 * 60_000))

    const res = await request(app)
      .post('/auth/reset-password')
      .send({ token, password: 'newpassword' })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'reset link is invalid or expired' })
  })

  it('refuses a token that was never issued, in the same words', async () => {
    const res = await request(app)
      .post('/auth/reset-password')
      .send({ token: 'made-up', password: 'newpassword' })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'reset link is invalid or expired' })
  })

  it('retires the older link when a second one is requested', async () => {
    const { email } = await signup()
    const first = await requestReset(email)

    // Past the throttle, so the second request actually issues.
    db.prepare(
      "UPDATE password_reset SET created_at = '2020-01-01T00:00:00.000Z'",
    ).run()
    const second = await requestReset(email)

    expect(second).not.toBe(first)
    expect(
      (
        await request(app)
          .post('/auth/reset-password')
          .send({ token: first, password: 'newpassword' })
      ).status,
    ).toBe(400)
    expect(
      (
        await request(app)
          .post('/auth/reset-password')
          .send({ token: second, password: 'newpassword' })
      ).status,
    ).toBe(200)
  })

  it('holds the new password to the same floor as signup', async () => {
    const res = await request(app)
      .post('/auth/reset-password')
      .send({ token: 'anything', password: 'short' })

    expect(res.status).toBe(400)
    // Terse, like login: the 400 must not say which field it disliked.
    expect(res.body).toEqual({ error: 'invalid body' })
  })

  it('goes with the account when it is deleted', async () => {
    const { token: session, email } = await signup()
    await requestReset(email)
    expect(resetRows()).toHaveLength(1)

    await authed(session)
      .post('/api/me/delete-account')
      .send({ password: 'password123' })

    expect(resetRows()).toHaveLength(0)
  })
})
