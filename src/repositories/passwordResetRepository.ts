import { randomUUID } from 'node:crypto'
import { db } from '../db/client'
import type { PasswordResetRow } from '../db/rows'

export interface NewPasswordReset {
  userId: string
  tokenHash: string
  /** ISO 8601. */
  now: string
  /** ISO 8601. */
  expiresAt: string
}

/** Drops rows nobody can redeem any more. Called on the way in to issuing one,
    so the table stays small without a scheduled job. */
export function pruneExpired(now: string): void {
  db.prepare('DELETE FROM password_reset WHERE expires_at <= ?').run(now)
}

/** True when this user was issued a token at or after `since` — the throttle's
    only question. */
export function issuedSince(userId: string, since: string): boolean {
  return (
    db
      .prepare(
        'SELECT id FROM password_reset WHERE user_id = ? AND created_at >= ? LIMIT 1',
      )
      .get(userId, since) !== undefined
  )
}

/** Retires the user's outstanding tokens. Marked used rather than deleted:
    the throttle reads created_at, and deleting would erase its own evidence. */
export function supersedeOutstanding(userId: string, now: string): void {
  db.prepare(
    'UPDATE password_reset SET used_at = ? WHERE user_id = ? AND used_at IS NULL',
  ).run(now, userId)
}

export function create(input: NewPasswordReset): string {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO password_reset (id, user_id, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, input.userId, input.tokenHash, input.now, input.expiresAt)
  return id
}

/**
 * Spends a token, returning the user it belonged to — or undefined when there
 * is no such token, it was already spent, or it has expired. Conditional rather
 * than read-then-write, so single-use and expiry are settled in one statement
 * and two simultaneous redemptions cannot both win.
 */
export function redeem(
  tokenHash: string,
  now: string,
): PasswordResetRow | undefined {
  return db
    .prepare(
      `UPDATE password_reset SET used_at = ?
        WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
        RETURNING *`,
    )
    .get(now, tokenHash, now) as PasswordResetRow | undefined
}
