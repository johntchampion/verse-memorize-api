import { Router } from 'express'
import { z } from 'zod'
import * as pushSubscriptions from '../repositories/pushSubscriptionRepository'
import { validate, validated } from '../lib/http'
import { userId } from '../middleware/auth'
import {
  assertPushConfigured,
  DAILY_REMINDER,
  sendToUser,
  vapidPublicKey,
} from '../services/pushSender'

export const pushRouter = Router()

/**
 * The server's VAPID public key, for PushManager.subscribe.
 *
 * Not a secret, but it sits behind the auth guard like everything else under
 * /api — the only caller is a signed-in client about to subscribe. A 503 here
 * (from vapidPublicKey, via the error handler) is what tells the client this
 * deployment has no keys, so the settings toggle renders as unavailable rather
 * than as broken.
 */
pushRouter.get('/push/key', (_req, res) => {
  res.json({ publicKey: vapidPublicKey() })
})

// The shape of PushSubscription.toJSON(). Its expirationTime is stripped by
// zod, which is right — nothing here reads it.
const subscribeBody = z.object({
  // Push endpoints run long: FCM's are around 200 characters and other
  // services go further. This bound is a sanity check, not a fit.
  endpoint: z.url().max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(255),
    auth: z.string().min(1).max(255),
  }),
})

/**
 * Registers this browser to receive pushes.
 *
 * Idempotent on the endpoint, so a client that re-subscribes on every launch —
 * which is the right thing for it to do, since only the browser knows whether
 * its subscription survived — still writes one row.
 */
pushRouter.post('/push/subscribe', validate(subscribeBody), (req, res) => {
  const body = validated(req, subscribeBody)

  pushSubscriptions.upsert({
    userId: userId(req),
    endpoint: body.endpoint,
    p256dh: body.keys.p256dh,
    auth: body.keys.auth,
    userAgent: req.get('user-agent')?.slice(0, 255) ?? null,
    now: new Date().toISOString(),
  })

  res.status(201).json({ subscribed: true })
})

const unsubscribeBody = z.object({ endpoint: z.url().max(2048) })

/**
 * Drops one of the caller's own registrations.
 *
 * POST rather than DELETE because it needs a body to say which device, and a
 * DELETE body is the sort of thing intermediaries feel free to drop.
 */
pushRouter.post('/push/unsubscribe', validate(unsubscribeBody), (req, res) => {
  const body = validated(req, unsubscribeBody)

  pushSubscriptions.removeForUser(userId(req), body.endpoint)
  res.json({ subscribed: false })
})

/**
 * Sends the reminder to the caller's own devices, now.
 *
 * Worth having as a real endpoint: it is the only way to check that a phone's
 * service worker renders the notification without waiting until 9pm, and it
 * can only ever address the subscriptions of whoever is calling it.
 */
pushRouter.post('/push/test', async (req, res) => {
  // Up front, so a deployment that cannot send says so with a 503 instead of
  // reporting its own misconfiguration as a failure of every device.
  assertPushConfigured()

  const result = await sendToUser(userId(req), {
    ...DAILY_REMINDER,
    body: 'Reminders are working.',
  })
  res.json(result)
})
