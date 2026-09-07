/**
 * Mailjet's Send API v3.1. Env is read at call time, mirroring services/vapid.ts:
 * a deployment with nothing configured still boots and answers 503 rather than
 * failing to start.
 */
import { MailNotConfiguredError } from '../lib/errors'

const SEND_URL = 'https://api.mailjet.com/v3.1/send'

/** Global fetch has no timeout of its own, and a hung request here would hold
    an Express handler open indefinitely. */
const TIMEOUT_MS = 10_000

const DEFAULT_FROM_NAME = 'Verse Memorize'

export interface Email {
  to: string
  subject: string
  text: string
  html: string
}

export type Sender = (email: Email) => Promise<void>

export function mailerConfigured(): boolean {
  return Boolean(
    process.env.MAILJET_API_KEY &&
    process.env.MAILJET_SECRET_KEY &&
    process.env.MAIL_FROM_EMAIL &&
    process.env.APP_BASE_URL,
  )
}

/** Callers that own a status code use this up front, so a deployment with no
    credentials answers 503 instead of accepting requests it will never fulfil. */
export function assertMailConfigured(): void {
  if (!mailerConfigured()) throw new MailNotConfiguredError()
}

/**
 * Where the emailed link points. Validated here rather than trusted, because a
 * malformed value produces `undefined/reset-password?token=…` in a real email
 * and nothing else notices — server.ts calls this at boot for that reason.
 */
export function appBaseUrl(): string {
  const raw = process.env.APP_BASE_URL
  if (!raw) throw new MailNotConfiguredError()

  try {
    return new URL(raw).origin
  } catch {
    throw new Error(
      `APP_BASE_URL must be an absolute URL, got "${raw}". It is the origin every emailed link points at.`,
    )
  }
}

let transport: Sender

/**
 * Swaps the transport. The only caller outside this module is the test suite,
 * which must never reach api.mailjet.com — the alternative is every test that
 * touches a reset route sending real mail.
 */
export function useTransport(sender: Sender): void {
  transport = sender
}

/** Sends through whatever transport is installed, Mailjet by default. */
export function sendEmail(email: Email): Promise<void> {
  return transport(email)
}

function authHeader(): string {
  const key = process.env.MAILJET_API_KEY
  const secret = process.env.MAILJET_SECRET_KEY
  if (!key || !secret) throw new MailNotConfiguredError()
  return `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`
}

interface SendResponse {
  Messages?: { Status?: string; Errors?: { ErrorMessage?: string }[] }[]
}

/**
 * v3.1 answers 200 with a per-message status, so a message that was rejected
 * at submit still arrives here as a successful HTTP response. The status is
 * what has to be checked.
 */
export const sendViaMailjet: Sender = async (email) => {
  const from = process.env.MAIL_FROM_EMAIL
  if (!from) throw new MailNotConfiguredError()

  const res = await fetch(SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      Messages: [
        {
          From: {
            Email: from,
            Name: process.env.MAIL_FROM_NAME || DEFAULT_FROM_NAME,
          },
          To: [{ Email: email.to }],
          Subject: email.subject,
          TextPart: email.text,
          HTMLPart: email.html,
        },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  const body = (await res.json().catch(() => null)) as SendResponse | null
  const message = body?.Messages?.[0]

  if (!res.ok || message?.Status !== 'success') {
    const detail =
      message?.Errors?.map((e) => e.ErrorMessage).join('; ') ??
      `HTTP ${res.status}`
    throw new Error(`Mailjet rejected the message: ${detail}`)
  }
}

transport = sendViaMailjet
