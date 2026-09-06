/**
 * Delivering a Web Push message to a user's devices.
 *
 * The configuration is read at call time rather than at module load, the same
 * way middleware/auth.ts reads JWT_SECRET. Reminders are not load-bearing the
 * way auth is, so a deployment with *nothing* configured still boots: the
 * scheduler doesn't run and the routes answer 503.
 *
 * Configuration that is present but *wrong* is treated the opposite way, and
 * fails at boot — see vapidSubject. Half-working is the worst outcome here,
 * because each push service validates a different amount and the ones that
 * don't will happily keep delivering while another silently stops.
 */
import webpush, { WebPushError } from 'web-push'
import * as pushSubscriptions from '../db/pushSubscriptionRepository'
import type { PushSubscriptionRow } from '../db/client'
import { PushNotConfiguredError } from '../lib/errors'

/** True when this deployment has a VAPID key pair and a contact subject. */
export function vapidConfigured(): boolean {
  return Boolean(
    process.env.VAPID_PUBLIC_KEY &&
    process.env.VAPID_PRIVATE_KEY &&
    process.env.VAPID_SUBJECT,
  )
}

/**
 * RFC 2606 / RFC 6761 reserved names, which are guaranteed never to resolve.
 *
 * Apple's push service validates the JWT's `sub` and rejects an unroutable one
 * with `403 {"reason":"BadJwtToken"}`. Mozilla and Google don't check, so a
 * placeholder subject produces a deployment where Firefox and Chrome work,
 * Safari silently doesn't, and the only clue is a status code on the server.
 * Refusing the placeholder outright is much cheaper than debugging that.
 */
const UNROUTABLE = /\.(invalid|example|test|localhost)$/i

/**
 * The contact address the push services use to reach whoever runs this server.
 *
 * Required rather than defaulted: there is no generic value that actually
 * works, so a default could only be a placeholder, and a placeholder here
 * breaks Apple alone. Validated at boot for the same reason `jwtSecret()` is —
 * a misconfiguration should be loud and immediate, not a subset of users
 * quietly never being reminded.
 */
export function vapidSubject(): string {
  const subject = process.env.VAPID_SUBJECT
  if (!subject) throw new PushNotConfiguredError()

  const host =
    subject.startsWith('mailto:') && subject.includes('@')
      ? subject.slice(subject.lastIndexOf('@') + 1)
      : subject.startsWith('https://')
        ? new URL(subject).hostname
        : null

  if (host === null) {
    throw new Error(
      `VAPID_SUBJECT must be a mailto: address or an https: URL, got "${subject}"`,
    )
  }
  if (UNROUTABLE.test(host)) {
    throw new Error(
      `VAPID_SUBJECT "${subject}" uses a reserved domain that can never receive mail. ` +
        "Apple's push service rejects it with BadJwtToken while Firefox and Chrome " +
        'accept it, so use a real contact address you monitor.',
    )
  }
  return subject
}

/**
 * The public half of the key pair, which the browser needs as
 * `applicationServerKey` when it subscribes.
 *
 * Never rotate this in a live deployment. A push service rejects a message
 * signed by a key that doesn't match the one the client subscribed with, so a
 * rotation silently invalidates every existing subscription: 403s in the log,
 * nothing in the UI, and every user having to re-enable a toggle they have no
 * reason to touch.
 */
export function vapidPublicKey(): string {
  const key = process.env.VAPID_PUBLIC_KEY
  if (!key) throw new PushNotConfiguredError()
  return key
}

let configured = false

function configureVapid(): void {
  if (configured) return
  const privateKey = process.env.VAPID_PRIVATE_KEY
  if (!privateKey) throw new PushNotConfiguredError()
  webpush.setVapidDetails(vapidSubject(), vapidPublicKey(), privateKey)
  configured = true
}

/**
 * Fails unless this deployment can actually send.
 *
 * Callers that own a status code should use this before fanning out, because
 * sendToUser deliberately turns a per-device failure into a tally rather than
 * an error — which would report one misconfiguration as N dead devices.
 */
export function assertPushConfigured(): void {
  vapidPublicKey()
  vapidSubject()
  if (!process.env.VAPID_PRIVATE_KEY) throw new PushNotConfiguredError()
}

/** Only exported for tests, which stub the env between cases. */
export function resetVapidForTests(): void {
  configured = false
}

export interface ReminderPayload {
  title: string
  body: string
  /** Where notificationclick should land, relative to the app's origin. */
  url: string
  /** Collapses repeats on the device. */
  tag: string
}

/**
 * Collapses undelivered reminders on the push service, so a device that was
 * off for three days gets one on waking rather than three.
 *
 * The value looks arbitrary and isn't. RFC 8030 allows up to 32 characters
 * from the URL-safe base64 alphabet, but **Apple additionally decodes the
 * topic as base64url**, so any length that is impossible for base64 — i.e.
 * `length % 4 === 1` — is rejected with `400 {"reason":"BadWebPushTopic"}`
 * while every other push service accepts it. `dailyreminder` (13) fails;
 * `daily-reminder` (14) works. See tests/push.test.ts, which pins this so it
 * can't be quietly "tidied" back into an invalid length.
 */
export const REMINDER_TOPIC = 'daily-reminder'

/** Kept short: an encrypted payload has about 4KB to work with, and some push
    services are stricter than that in practice. */
export const DAILY_REMINDER: ReminderPayload = {
  title: 'Time to practise',
  body: 'Your verses are waiting.',
  url: '/',
  tag: 'daily-reminder',
}

export type SendResult =
  /** Accepted by the push service. */
  | 'sent'
  /** The push service says this endpoint is dead; the row should go. */
  | 'gone'
  /** Something else went wrong; the endpoint may still be good. */
  | 'failed'

export async function sendToSubscription(
  subscription: PushSubscriptionRow,
  payload: ReminderPayload,
): Promise<SendResult> {
  configureVapid()

  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify(payload),
      {
        // An hour. A reminder that surfaces six hours late is noise, so let
        // the push service drop it rather than deliver it stale.
        TTL: 3600,
        // Not 'high': a practice nudge does not justify waking a dozing
        // phone's radio.
        urgency: 'normal',
        // See REMINDER_TOPIC — the exact string matters to Apple.
        topic: REMINDER_TOPIC,
      },
    )
    return 'sent'
  } catch (err) {
    const status = err instanceof WebPushError ? err.statusCode : 0
    if (status === 404 || status === 410) return 'gone'
    // 400 is a malformed subscription, 413 an oversized payload, 429
    // back-pressure. None of them mean the endpoint is dead, so the row stays,
    // but they are logged loudly.
    //
    // 403 deserves special suspicion: it means the push service rejected our
    // credentials, not our request, so it hits every subscription on that
    // service at once. Apple sends it with `{"reason":"BadJwtToken"}` for a
    // VAPID subject it won't accept — which Firefox and Chrome allow, so the
    // symptom is "Safari alone stopped working". A rotated key pair looks the
    // same but breaks every service at once. Check the body.
    console.error(
      `push send failed (${status || 'network'}) for subscription ${subscription.id}`,
      err,
    )
    return 'failed'
  }
}

export interface FanOutResult {
  sent: number
  /** Endpoints the push service reported dead, now deleted. */
  removed: number
  failed: number
}

/**
 * Sends one payload to every device the user has registered.
 *
 * Devices go out in parallel — one dead endpoint must not abort the others —
 * and a 'gone' verdict deletes the row, because the push service has told us
 * definitively that nothing will ever be delivered to it again.
 */
export async function sendToUser(
  userId: string,
  payload: ReminderPayload,
  send: (
    subscription: PushSubscriptionRow,
    payload: ReminderPayload,
  ) => Promise<SendResult> = sendToSubscription,
): Promise<FanOutResult> {
  const subscriptions = pushSubscriptions.forUser(userId)

  const results = await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        return await send(subscription, payload)
      } catch (err) {
        // An injected sender, or web-push itself, throwing something that
        // isn't a WebPushError. One device's failure isn't the others'.
        console.error(
          `push send threw for subscription ${subscription.id}`,
          err,
        )
        return 'failed' as SendResult
      }
    }),
  )

  const tally: FanOutResult = { sent: 0, removed: 0, failed: 0 }
  results.forEach((result, index) => {
    if (result === 'sent') {
      tally.sent += 1
    } else if (result === 'gone') {
      pushSubscriptions.removeByEndpoint(subscriptions[index].endpoint)
      tally.removed += 1
    } else {
      tally.failed += 1
    }
  })
  return tally
}
