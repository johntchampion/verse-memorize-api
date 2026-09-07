/**
 * Read at call time, so a deployment with nothing configured still boots and
 * answers 503. Configuration that is present but *wrong* fails at boot instead:
 * each push service validates a different amount, so half-working means one
 * silently stops while the others keep delivering.
 */
import webpush from 'web-push'
import { PushNotConfiguredError } from '../lib/errors'

export function vapidConfigured(): boolean {
  return Boolean(
    process.env.VAPID_PUBLIC_KEY &&
    process.env.VAPID_PRIVATE_KEY &&
    process.env.VAPID_SUBJECT,
  )
}

/**
 * RFC 2606 / 6761 reserved names. Apple validates the JWT's `sub` and rejects an
 * unroutable one with `403 {"reason":"BadJwtToken"}`; Mozilla and Google don't
 * check — so a placeholder gives you a deployment where Safari silently fails.
 */
const UNROUTABLE = /\.(invalid|example|test|localhost)$/i

function hostOf(subject: string): string | null {
  if (subject.startsWith('mailto:') && subject.includes('@')) {
    return subject.slice(subject.lastIndexOf('@') + 1)
  }
  if (subject.startsWith('https://')) return new URL(subject).hostname
  return null
}

/** Any default could only be a placeholder, which breaks Apple alone. */
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
 * Never rotate this in a live deployment. A push service rejects a message
 * signed by a key that doesn't match the one the client subscribed with, so a
 * rotation silently invalidates every existing subscription: 403s in the log,
 * nothing in the UI, and every user having to re-enable a toggle.
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

/** Memoized on the values, not a boolean: changing the environment reconfigures
    instead of silently keeping the old credentials. */
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

/** Callers that own a status code use this before fanning out: sendToUser
    tallies per-device failures, reporting one misconfiguration as N dead
    devices. */
export function assertPushConfigured(): void {
  vapidPublicKey()
  vapidSubject()
  vapidPrivateKey()
}
