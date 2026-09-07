import request from 'supertest'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../src/db/client'
import type { PushSubscriptionRow } from '../src/db/client'
import { app, authed, initDb, resetDb, signup } from './helpers'
import { REMINDER_TOPIC } from '../src/services/pushSender'
import { vapidSubject } from '../src/services/vapid'

beforeAll(initDb)
beforeEach(() => {
  resetDb()
})

const endpoint = 'https://push.example.com/send/abc123'

function subscriptionBody(overrides: Record<string, unknown> = {}) {
  return {
    endpoint,
    // The browser sends expirationTime too; zod strips it, and nothing reads it.
    expirationTime: null,
    keys: { p256dh: 'client-public-key', auth: 'client-auth-secret' },
    ...overrides,
  }
}

function subscriptionsFor(userId: string): PushSubscriptionRow[] {
  return db
    .prepare('SELECT * FROM push_subscription WHERE user_id = ?')
    .all(userId) as PushSubscriptionRow[]
}

describe('GET /api/push/key', () => {
  it('returns the configured public key', async () => {
    const { token } = await signup()

    const res = await authed(token).get('/api/push/key')

    expect(res.status).toBe(200)
    expect(res.body.publicKey).toBe(process.env.VAPID_PUBLIC_KEY)
  })

  it('requires a token', async () => {
    const res = await request(app).get('/api/push/key')
    expect(res.status).toBe(401)
  })

  // 503 rather than 500: the deployment simply has no keys, which is what the
  // client reads to render the toggle as unavailable rather than broken.
  it('is 503 on a deployment with no keys', async () => {
    const { token } = await signup()
    vi.stubEnv('VAPID_PUBLIC_KEY', '')

    const res = await authed(token).get('/api/push/key')

    expect(res.status).toBe(503)
    expect(res.body.error).toMatch(/not configured/)
    vi.unstubAllEnvs()
  })
})

// Apple decodes the Topic header as base64url on top of what RFC 8030 asks
// for, so a length of `4n + 1` is impossible base64 and comes back as
// 400 BadWebPushTopic — from Apple only. This is the guard on a one-character
// edit turning reminders off for every Safari user.
describe('REMINDER_TOPIC', () => {
  it('is a length Apple can decode as base64url', () => {
    expect(REMINDER_TOPIC.length % 4).not.toBe(1)
  })

  it('is within the 32 characters RFC 8030 allows, from its alphabet', () => {
    expect(REMINDER_TOPIC.length).toBeLessThanOrEqual(32)
    expect(REMINDER_TOPIC).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

// Apple validates the JWT's `sub` and answers 403 BadJwtToken for an
// unroutable one; Mozilla and Google don't check at all. A placeholder
// therefore yields a deployment where Firefox works and Safari silently
// doesn't, which is why this is refused up front rather than at send time.
describe('vapidSubject', () => {
  it('accepts a real mailto: address', () => {
    vi.stubEnv('VAPID_SUBJECT', 'mailto:admin@verse-memorize.org')
    expect(vapidSubject()).toBe('mailto:admin@verse-memorize.org')
    vi.unstubAllEnvs()
  })

  it('accepts an https: URL', () => {
    vi.stubEnv('VAPID_SUBJECT', 'https://verse-memorize.org/contact')
    expect(vapidSubject()).toBe('https://verse-memorize.org/contact')
    vi.unstubAllEnvs()
  })

  it.each([
    'mailto:dev@example.invalid',
    'mailto:dev@example.test',
    'mailto:dev@my.example',
    'https://example.invalid',
  ])('refuses the reserved domain in %s', (subject) => {
    vi.stubEnv('VAPID_SUBJECT', subject)
    expect(() => vapidSubject()).toThrow(/reserved domain/)
    vi.unstubAllEnvs()
  })

  it('refuses a subject that is neither mailto: nor https:', () => {
    vi.stubEnv('VAPID_SUBJECT', 'admin@verse-memorize.org')
    expect(() => vapidSubject()).toThrow(/must be a mailto:/)
    vi.unstubAllEnvs()
  })

  it('treats a missing subject as an unconfigured deployment', async () => {
    const { token } = await signup()
    vi.stubEnv('VAPID_SUBJECT', '')

    // The key endpoint stays available — only sending needs the subject —
    // but the scheduler won't run without it.
    const res = await authed(token).post('/api/push/test').send()

    expect(res.status).toBe(503)
    vi.unstubAllEnvs()
  })
})

describe('POST /api/push/subscribe', () => {
  it('stores the subscription', async () => {
    const { token, userId } = await signup()

    const res = await authed(token)
      .post('/api/push/subscribe')
      .send(subscriptionBody())

    expect(res.status).toBe(201)
    expect(res.body).toEqual({ subscribed: true })

    const rows = subscriptionsFor(userId)
    expect(rows).toHaveLength(1)
    expect(rows[0].endpoint).toBe(endpoint)
    expect(rows[0].p256dh).toBe('client-public-key')
    expect(rows[0].auth).toBe('client-auth-secret')
  })

  // A client re-subscribes on every launch, because only the browser knows
  // whether its subscription survived. That must not accumulate rows.
  it('is idempotent on the endpoint, refreshing the keys', async () => {
    const { token, userId } = await signup()

    await authed(token).post('/api/push/subscribe').send(subscriptionBody())
    await authed(token)
      .post('/api/push/subscribe')
      .send(
        subscriptionBody({ keys: { p256dh: 'rotated', auth: 'refreshed' } }),
      )

    const rows = subscriptionsFor(userId)
    expect(rows).toHaveLength(1)
    expect(rows[0].p256dh).toBe('rotated')
    expect(rows[0].auth).toBe('refreshed')
  })

  // A device that changed hands must stop being addressed as its old owner.
  it('reassigns an endpoint that comes back under another account', async () => {
    const first = await signup()
    const second = await signup()

    await authed(first.token)
      .post('/api/push/subscribe')
      .send(subscriptionBody())
    await authed(second.token)
      .post('/api/push/subscribe')
      .send(subscriptionBody())

    expect(subscriptionsFor(first.userId)).toHaveLength(0)
    expect(subscriptionsFor(second.userId)).toHaveLength(1)
  })

  it('rejects a body that is not a subscription', async () => {
    const { token } = await signup()

    const res = await authed(token)
      .post('/api/push/subscribe')
      .send({ endpoint: 'not-a-url', keys: { p256dh: 'a', auth: 'b' } })

    expect(res.status).toBe(400)
  })

  it('records the user agent for diagnostics', async () => {
    const { token, userId } = await signup()

    await authed(token)
      .post('/api/push/subscribe')
      .set('user-agent', 'TestBrowser/1.0')
      .send(subscriptionBody())

    expect(subscriptionsFor(userId)[0].user_agent).toBe('TestBrowser/1.0')
  })
})

describe('POST /api/push/unsubscribe', () => {
  it('removes the caller’s registration', async () => {
    const { token, userId } = await signup()
    await authed(token).post('/api/push/subscribe').send(subscriptionBody())

    const res = await authed(token)
      .post('/api/push/unsubscribe')
      .send({ endpoint })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ subscribed: false })
    expect(subscriptionsFor(userId)).toHaveLength(0)
  })

  // Knowing someone else's endpoint must not be enough to silence them.
  it('cannot remove another account’s registration', async () => {
    const owner = await signup()
    const stranger = await signup()
    await authed(owner.token)
      .post('/api/push/subscribe')
      .send(subscriptionBody())

    const res = await authed(stranger.token)
      .post('/api/push/unsubscribe')
      .send({ endpoint })

    expect(res.status).toBe(200)
    expect(subscriptionsFor(owner.userId)).toHaveLength(1)
  })
})

describe('PATCH /api/me remindersEnabled', () => {
  it('is off for a new account', async () => {
    const { token } = await signup()

    const res = await authed(token).get('/api/me')

    expect(res.body.user.remindersEnabled).toBe(false)
  })

  it('round-trips through GET /api/me', async () => {
    const { token } = await signup()

    const patched = await authed(token)
      .patch('/api/me')
      .send({ remindersEnabled: true })
    expect(patched.status).toBe(200)
    expect(patched.body.user.remindersEnabled).toBe(true)

    const fetched = await authed(token).get('/api/me')
    expect(fetched.body.user.remindersEnabled).toBe(true)
  })

  it('turns back off', async () => {
    const { token } = await signup()
    await authed(token).patch('/api/me').send({ remindersEnabled: true })

    const res = await authed(token)
      .patch('/api/me')
      .send({ remindersEnabled: false })

    expect(res.body.user.remindersEnabled).toBe(false)
  })

  // Turning the toggle off leaves the devices registered, so switching it back
  // on costs no permission prompt and no re-subscribe.
  it('leaves push subscriptions in place when turned off', async () => {
    const { token, userId } = await signup()
    await authed(token).post('/api/push/subscribe').send(subscriptionBody())
    await authed(token).patch('/api/me').send({ remindersEnabled: true })

    await authed(token).patch('/api/me').send({ remindersEnabled: false })

    expect(subscriptionsFor(userId)).toHaveLength(1)
  })

  it('combines with the other preferences in one patch', async () => {
    const { token } = await signup()

    const res = await authed(token)
      .patch('/api/me')
      .send({ timezone: 'America/Chicago', remindersEnabled: true })

    expect(res.status).toBe(200)
    expect(res.body.user.timezone).toBe('America/Chicago')
    expect(res.body.user.remindersEnabled).toBe(true)
  })

  it('still rejects an empty body', async () => {
    const { token } = await signup()

    const res = await authed(token).patch('/api/me').send({})

    expect(res.status).toBe(400)
  })

  it('rejects a non-boolean', async () => {
    const { token } = await signup()

    const res = await authed(token)
      .patch('/api/me')
      .send({ remindersEnabled: 'yes' })

    expect(res.status).toBe(400)
  })
})
