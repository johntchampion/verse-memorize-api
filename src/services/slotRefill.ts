import { randomUUID } from 'node:crypto'
import { db, type UserVerseRow } from '../db/client'
import { versesInOrder } from '../data/verses'

/** A user holds at most 3 active learning slots at once. */
export const MAX_SLOTS = 3

/**
 * The next verse in `order` the user has no user_verse row for, or undefined
 * once the whole bank has been assigned — slots then just stay empty, there is
 * no wraparound in v1.
 */
function nextUnassignedVerseId(userId: string): string | undefined {
  const assigned = new Set(
    (
      db
        .prepare('SELECT verse_id FROM user_verse WHERE user_id = ?')
        .all(userId) as {
        verse_id: string
      }[]
    ).map((r) => r.verse_id),
  )
  return versesInOrder().find((v) => !assigned.has(v.id))?.id
}

/**
 * The verse that has been waiting longest to get back into a learning slot,
 * having been pulled out of review for repeated misses.
 */
function oldestQueuedRelearner(userId: string): UserVerseRow | undefined {
  return db
    .prepare(
      `SELECT * FROM user_verse
        WHERE user_id = ? AND needs_relearning = 1
        ORDER BY relearning_queued_at ASC
        LIMIT 1`,
    )
    .get(userId) as UserVerseRow | undefined
}

/**
 * Fills every empty slot.
 *
 * All 3 slots are live from signup — there is no ramp-up. Verses waiting to be
 * relearned take priority over unseen ones, oldest queued first; they re-enter
 * at learning_heavy specifically, never lower. Called at signup, at the end of
 * POST /api/session/complete, and whenever an attempt either empties a slot or
 * queues a relearner. Returns the rows that took a slot.
 */
export function refillSlots(userId: string): UserVerseRow[] {
  const occupied = new Set(
    (
      db
        .prepare(
          'SELECT slot FROM user_verse WHERE user_id = ? AND slot IS NOT NULL',
        )
        .all(userId) as { slot: number }[]
    ).map((r) => r.slot),
  )

  const filled: UserVerseRow[] = []

  const promote = db.prepare(
    `UPDATE user_verse
        SET stage = 'learning_heavy',
            slot = ?,
            needs_relearning = 0,
            relearning_queued_at = NULL,
            consecutive_correct = 0,
            consecutive_incorrect = 0,
            streak_date = NULL,
            interval_days = NULL,
            due_at = NULL,
            last_upgrade_date = NULL,
            last_downgrade_date = NULL
      WHERE id = ?`,
  )

  const insert = db.prepare(
    `INSERT INTO user_verse (id, user_id, verse_id, stage, slot, activated_at)
     VALUES (?, ?, ?, 'learning_light', ?, ?)`,
  )

  const read = db.prepare('SELECT * FROM user_verse WHERE id = ?')

  for (let slot = 1; slot <= MAX_SLOTS; slot += 1) {
    if (occupied.has(slot)) continue

    const relearner = oldestQueuedRelearner(userId)
    if (relearner) {
      promote.run(slot, relearner.id)
      filled.push(read.get(relearner.id) as UserVerseRow)
      continue
    }

    const verseId = nextUnassignedVerseId(userId)
    if (!verseId) break // Bank exhausted — leave the slot empty.

    const id = randomUUID()
    insert.run(id, userId, verseId, slot, new Date().toISOString())
    filled.push(read.get(id) as UserVerseRow)
  }

  return filled
}
