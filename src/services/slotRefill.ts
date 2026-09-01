import { randomUUID } from 'node:crypto'
import { db, type UserVerseRow } from '../db/client'
import { getVerse } from '../data/verses'
import { isQueued, queueVerseIds } from './queue'

/** A user holds at most 3 active learning slots at once. */
export const MAX_SLOTS = 3

// Statements are prepared inside the functions (not at module load) because
// this module is imported before migrate() has created the tables.

function readById(id: string): UserVerseRow {
  return db
    .prepare('SELECT * FROM user_verse WHERE id = ?')
    .get(id) as UserVerseRow
}

/**
 * Puts one queued verse into one (empty) slot, whatever its state: a relearner
 * re-enters at heavy, a paused verse resumes where it left off, an untouched
 * verse starts at light. Returns the resulting row.
 */
function activateIntoSlot(
  userId: string,
  verseId: string,
  slot: number,
  row: UserVerseRow | undefined,
): UserVerseRow {
  if (row) {
    if (row.needs_relearning === 1) {
      // A relearner re-enters at learning_heavy specifically, never lower,
      // with its counters and schedule wiped — same semantics as before the
      // queue existed.
      db.prepare(
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
      ).run(slot, row.id)
    } else {
      // A verse swapped out mid-learning takes the slot back with its tier,
      // counters and history untouched.
      db.prepare('UPDATE user_verse SET slot = ? WHERE id = ?').run(
        slot,
        row.id,
      )
    }
    return readById(row.id)
  }
  const id = randomUUID()
  db.prepare(
    `INSERT INTO user_verse (id, user_id, verse_id, stage, slot, activated_at)
     VALUES (?, ?, ?, 'learning_light', ?, ?)`,
  ).run(id, userId, verseId, slot, new Date().toISOString())
  return readById(id)
}

function rowForVerse(
  userId: string,
  verseId: string,
): UserVerseRow | undefined {
  return db
    .prepare('SELECT * FROM user_verse WHERE user_id = ? AND verse_id = ?')
    .get(userId, verseId) as UserVerseRow | undefined
}

/**
 * Fills every empty slot from the front of the practice queue.
 *
 * All 3 slots are live from signup — there is no ramp-up. The queue's default
 * order keeps the old behavior (relearners and swapped-out verses first, then
 * the curriculum), but the user can reorder it, so refill simply takes the
 * top. Called at signup, at the end of POST /api/session/complete, whenever an
 * attempt empties a slot or queues a relearner, and by the queue routes after
 * an explicit slot swap. Returns the rows that took a slot.
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
  const queue = queueVerseIds(userId)
  let next = 0

  for (let slot = 1; slot <= MAX_SLOTS; slot += 1) {
    if (occupied.has(slot)) continue

    const verseId = queue[next]
    next += 1
    if (!verseId) break // Queue exhausted — leave the slot empty.

    filled.push(
      activateIntoSlot(userId, verseId, slot, rowForVerse(userId, verseId)),
    )
  }

  return filled
}

/**
 * Swaps the occupant of a slot out (progress saved — it rejoins the queue as
 * an in-progress verse) and puts `verseId` in its place. The incoming verse
 * must be queue-eligible: not memorized, not already holding a slot.
 */
export function replaceSlot(
  userId: string,
  verseId: string,
  slot: number,
): { placed: UserVerseRow; displaced: UserVerseRow | null } {
  if (!getVerse(verseId)) throw new SlotError('verse not found', 404)
  if (slot < 1 || slot > MAX_SLOTS) throw new SlotError('no such slot', 400)

  const incoming = rowForVerse(userId, verseId)
  if (!isQueued(incoming)) {
    throw new SlotError(
      'verse is not available for practice — it is already in a slot or memorized',
      400,
    )
  }

  const displaced = db
    .prepare(
      'SELECT * FROM user_verse WHERE user_id = ? AND slot = ?',
    )
    .get(userId, slot) as UserVerseRow | undefined

  if (displaced) {
    db.prepare('UPDATE user_verse SET slot = NULL WHERE id = ?').run(
      displaced.id,
    )
  }

  const placed = activateIntoSlot(userId, verseId, slot, incoming)
  return {
    placed,
    displaced: displaced
      ? readById(displaced.id)
      : null,
  }
}

/** Invalid slot input — routes map it to a 4xx rather than a 500. */
export class SlotError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}
