/**
 * VAPID configuration for Web Push.
 *
 * Read at call time rather than module load, the same way middleware/auth.ts
 * reads JWT_SECRET. Reminders are not load-bearing the way auth is, so a
 * deployment with nothing configured still boots: the scheduler doesn't run and
 * the routes answer 503. Configuration that is present but wrong fails at boot
 * instead — half-working is the worst outcome here, because each push service
 * validates a different amount and the ones that don't will happily keep
 * delivering while another silently stops.
 */
import webpush from 'web-push'
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
 * RFC 2606 / RFC 6761 reserved names, guaranteed never to resolve.
 *
 * Apple's push service validates the JWT's `sub` and rejects an unroutable one
 * with `403 {"reason":"BadJwtToken"}`. Mozilla and Google don't check, so a
 * placeholder subject produces a deployment where Firefox and Chrome work,
 * Safari silently doesn't, and the only clue is a status code on the server.
 */
const UNROUTABLE = /\.(invalid|example|test|localhost)$/i

function hostOf(subject: string): string | null {
  if (subject.startsWith('mailto:') && subject.includes('@')) {
    return subject.slice(subject.lastIndexOf('@') + 1)
  }
  if (subject.startsWith('https://')) return new URL(subject).hostname
  return null
}

/**
 * The contact address the push services use to reach whoever runs this server.
 *
 * Required rather than defaulted: there is no generic value that works, so a
 * default could only be a placeholder, and a placeholder here breaks Apple
 * alone.
 */
export function vapidSubject(): string {
  const subject = process.env.VAPID_SUBJECT
  if (!subject) throw new PushNotConfiguredError()

  const host = hostOf(subject)
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

function vapidPrivateKey(): string {
  const key = process.env.VAPID_PRIVATE_KEY
  if (!key) throw new PushNotConfiguredError()
  return key
}

/**
 * web-push keeps VAPID details in module state, so this memoizes on the values
 * themselves rather than on a boolean: changing the environment reconfigures
 * instead of silently keeping the old credentials.
 */
let configuredWith: string | null = null

export function configureVapid(): void {
  const subject = vapidSubject()
  const publicKey = vapidPublicKey()
  const privateKey = vapidPrivateKey()

  const identity = `${subject} ${publicKey} ${privateKey}`
  if (configuredWith === identity) return

  webpush.setVapidDetails(subject, publicKey, privateKey)
  configuredWith = identity
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
  vapidPrivateKey()
}
