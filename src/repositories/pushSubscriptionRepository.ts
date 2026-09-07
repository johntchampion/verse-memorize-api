/** A row is one browser or device, not one user: a phone and a laptop are two
    rows, and one reminder fans out to both. */
import { randomUUID } from 'node:crypto'
import { db } from '../db/client'
import type { PushSubscriptionRow } from '../db/rows'

export interface NewSubscription {
  userId: string
  endpoint: string
  p256dh: string
  auth: string
  userAgent: string | null
  /** ISO 8601. */
  now: string
}

/**
 * Upsert because a client re-subscribes on every launch, and the same browser
 * against the same VAPID key gets the same endpoint back. user_id is
 * overwritten too: an endpoint returning under a different account is a device
 * that changed hands, and it must stop being addressed as its previous owner.
 */
export function upsert(input: NewSubscription): void {
  db.prepare(
    `INSERT INTO push_subscription
       (id, user_id, endpoint, p256dh, auth, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       user_agent = excluded.user_agent`,
  ).run(
    randomUUID(),
    input.userId,
    input.endpoint,
    input.p256dh,
    input.auth,
    input.userAgent,
    input.now,
  )
}

export function forUser(userId: string): PushSubscriptionRow[] {
  return db
    .prepare(
      'SELECT * FROM push_subscription WHERE user_id = ? ORDER BY created_at',
    )
    .all(userId) as PushSubscriptionRow[]
}

/** Scoped to the user, so knowing someone else's endpoint isn't enough to
    unsubscribe them. */
export function removeForUser(userId: string, endpoint: string): number {
  return db
    .prepare('DELETE FROM push_subscription WHERE user_id = ? AND endpoint = ?')
    .run(userId, endpoint).changes
}

/** Unscoped on purpose: the caller is the sender reacting to a 404/410, which
    is the push service saying this address will never accept another message. */
export function removeByEndpoint(endpoint: string): void {
  db.prepare('DELETE FROM push_subscription WHERE endpoint = ?').run(endpoint)
}

export function countForUser(userId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM push_subscription WHERE user_id = ?')
    .get(userId) as { n: number }
  return row.n
}
