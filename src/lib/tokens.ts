/** Secrets that travel in a URL: generated once, stored only as a digest. */
import { createHash, randomBytes } from 'node:crypto'

/** 256 bits, base64url so it survives an email client's link detection intact. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * What the database holds. sha256 rather than bcrypt: the input is already
 * 256 bits of entropy, so there is no dictionary to slow an attacker down to,
 * and the lookup has to be an indexed equality match.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
