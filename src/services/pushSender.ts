/** Delivering a Web Push message to a user's devices. */
import webpush, { WebPushError } from 'web-push'
import type { PushSubscriptionRow } from '../db/client'
import * as pushSubscriptions from '../repositories/pushSubscriptionRepository'
import { configureVapid } from './vapid'

export interface ReminderPayload {
  title: string
  body: string
  /** Where notificationclick should land, relative to the app's origin. */
  url: string
  /** Collapses repeats on the device. */
  tag: string
}

/**
 * Collapses undelivered reminders on the push service, so a device that was off
 * for three days gets one on waking rather than three.
 *
 * The value looks arbitrary and isn't. RFC 8030 allows up to 32 characters from
 * the URL-safe base64 alphabet, but Apple additionally decodes the topic as
 * base64url, so any length impossible for base64 — i.e. `length % 4 === 1` — is
 * rejected with `400 {"reason":"BadWebPushTopic"}` while every other push
 * service accepts it. `dailyreminder` (13) fails; `daily-reminder` (14) works.
 */
export const REMINDER_TOPIC = 'daily-reminder'

/** Kept short: an encrypted payload has about 4KB, and some services are stricter. */
export const DAILY_REMINDER: ReminderPayload = {
  title: 'Time to practise',
  body: 'Your verses are waiting.',
  url: '/',
  tag: 'daily-reminder',
}

export type SendResult =
  | 'sent'
  /** The push service says this endpoint is dead; the row should go. */
  | 'gone'
  /** Something else went wrong; the endpoint may still be good. */
  | 'failed'

/** An hour: a reminder that surfaces six hours late is noise. */
const TTL_SECONDS = 3600

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
        TTL: TTL_SECONDS,
        // Not 'high': a practice nudge does not justify waking a dozing
        // phone's radio.
        urgency: 'normal',
        // See REMINDER_TOPIC — the exact string matters to Apple.
        topic: REMINDER_TOPIC,
      },
    )
    return 'sent'
  } catch (err) {
    return classifyFailure(err, subscription.id)
  }
}

function classifyFailure(err: unknown, subscriptionId: string): SendResult {
  const status = err instanceof WebPushError ? err.statusCode : 0
  if (status === 404 || status === 410) return 'gone'

  // 400 is a malformed subscription, 413 an oversized payload, 429
  // back-pressure. None mean the endpoint is dead, so the row stays.
  //
  // 403 deserves special suspicion: the push service rejected our credentials,
  // not our request, so it hits every subscription on that service at once.
  // Apple sends it with `{"reason":"BadJwtToken"}` for a VAPID subject it won't
  // accept, which Firefox and Chrome allow — so the symptom is "Safari alone
  // stopped working". A rotated key pair looks the same but breaks every
  // service at once. Check the body.
  console.error(
    `push send failed (${status || 'network'}) for subscription ${subscriptionId}`,
    err,
  )
  return 'failed'
}

export interface FanOutResult {
  sent: number
  /** Endpoints the push service reported dead, now deleted. */
  removed: number
  failed: number
}

export type Sender = (
  subscription: PushSubscriptionRow,
  payload: ReminderPayload,
) => Promise<SendResult>

/**
 * Sends one payload to every device the user has registered, in parallel — one
 * dead endpoint must not abort the others.
 */
export async function sendToUser(
  userId: string,
  payload: ReminderPayload,
  send: Sender = sendToSubscription,
): Promise<FanOutResult> {
  const subscriptions = pushSubscriptions.forUser(userId)
  const results = await Promise.all(
    subscriptions.map((subscription) => attempt(send, subscription, payload)),
  )

  const tally: FanOutResult = { sent: 0, removed: 0, failed: 0 }
  results.forEach((result, index) => {
    if (result === 'sent') {
      tally.sent += 1
    } else if (result === 'gone') {
      // The push service has said definitively that nothing will ever be
      // delivered to this address again.
      pushSubscriptions.removeByEndpoint(subscriptions[index].endpoint)
      tally.removed += 1
    } else {
      tally.failed += 1
    }
  })
  return tally
}

async function attempt(
  send: Sender,
  subscription: PushSubscriptionRow,
  payload: ReminderPayload,
): Promise<SendResult> {
  try {
    return await send(subscription, payload)
  } catch (err) {
    // An injected sender, or web-push itself, throwing something that isn't a
    // WebPushError. One device's failure isn't the others'.
    console.error(`push send threw for subscription ${subscription.id}`, err)
    return 'failed'
  }
}
