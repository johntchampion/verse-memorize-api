/**
 * Issuing a reset link. Both entry points — the public forgot-password route
 * and the signed-in button in Settings — go through here, so the throttle, the
 * expiry and the email body cannot drift apart.
 */
import { passwordResetEmail } from '../lib/passwordResetEmail'
import { generateToken, hashToken } from '../lib/tokens'
import type { User } from '../models/User'
import * as resets from '../repositories/passwordResetRepository'
import { appBaseUrl, sendEmail } from './mailer'

/** Short enough to limit exposure, long enough to find the mail on a phone. */
export const RESET_TTL_MINUTES = 30

/**
 * One email per address per minute, keyed on the user rather than the caller.
 * Both entry points share the key, so "email me a link" in Settings followed by
 * "forgot password?" on the login page sends one email, not two.
 */
const THROTTLE_SECONDS = 60

function minutesFrom(instant: Date, minutes: number): string {
  return new Date(instant.getTime() + minutes * 60_000).toISOString()
}

/**
 * Mints a token and starts the send without waiting for it. Deliberately not
 * awaited: the public route answers the same way whether or not the address has
 * an account, and blocking on Mailjet for the one case and not the other would
 * put the answer back in the response time.
 *
 * A delivery failure is therefore logged rather than raised — by the time it is
 * known, the response has gone.
 */
export function issueResetFor(user: User): void {
  const now = new Date()
  const iso = now.toISOString()

  resets.pruneExpired(iso)

  const since = new Date(now.getTime() - THROTTLE_SECONDS * 1000).toISOString()
  if (resets.issuedSince(user.id, since)) return

  // Retired before the new one is written, so a user only ever has one live
  // link and the newest email is the one that works.
  resets.supersedeOutstanding(user.id, iso)

  const token = generateToken()
  resets.create({
    userId: user.id,
    tokenHash: hashToken(token),
    now: iso,
    expiresAt: minutesFrom(now, RESET_TTL_MINUTES),
  })

  const url = `${appBaseUrl()}/reset-password?token=${encodeURIComponent(token)}`

  void sendEmail({
    to: user.email,
    ...passwordResetEmail(url, RESET_TTL_MINUTES),
  }).catch((err: unknown) => {
    console.error('password reset email failed to send', err)
  })
}
