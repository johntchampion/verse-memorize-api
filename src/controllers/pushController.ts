import type { Request } from 'express'
import { userId } from '../middleware/auth'
import * as pushSubscriptions from '../repositories/pushSubscriptionRepository'
import type { SubscribeInput, UnsubscribeInput } from '../schemas'
import { DAILY_REMINDER, sendToUser } from '../services/pushSender'
import { assertPushConfigured, vapidPublicKey } from '../services/vapid'

/** Diagnostic only, and the column is 255 wide. */
const USER_AGENT_LIMIT = 255

/**
 * Not a secret, but it sits behind the auth guard like everything else under
 * /api. A 503 here tells the client this deployment has no keys, so the
 * settings toggle renders as unavailable rather than as broken.
 */
export function key() {
  return { publicKey: vapidPublicKey() }
}

/** Idempotent on the endpoint, so a client may re-send it on every launch. */
export function subscribe(req: Request, body: SubscribeInput) {
  pushSubscriptions.upsert({
    userId: userId(req),
    endpoint: body.endpoint,
    p256dh: body.keys.p256dh,
    auth: body.keys.auth,
    userAgent: req.get('user-agent')?.slice(0, USER_AGENT_LIMIT) ?? null,
    now: new Date().toISOString(),
  })
  return { subscribed: true }
}

export function unsubscribe(req: Request, body: UnsubscribeInput) {
  pushSubscriptions.removeForUser(userId(req), body.endpoint)
  return { subscribed: false }
}

/** Can only ever address the subscriptions of whoever is calling it. */
export function test(req: Request) {
  // Up front, so a deployment that cannot send says so with a 503 instead of
  // reporting its own misconfiguration as a failure of every device.
  assertPushConfigured()

  return sendToUser(userId(req), {
    ...DAILY_REMINDER,
    body: 'Reminders are working.',
  })
}
