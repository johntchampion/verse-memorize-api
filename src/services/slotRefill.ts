import { getVerse } from '../data/verses'
import * as userVerses from '../db/userVerseRepository'
import type { UserVerse } from '../domain/userVerse'
import { isQueued, queueVerseIds } from './queue'

/** A user holds at most 3 active learning slots at once. */
export const MAX_SLOTS = 3

/**
 * Puts one queued verse into one (empty) slot, whatever its state: a relearner
 * re-enters at heavy, a paused verse resumes where it left off, an untouched
 * verse starts at light.
 */
function activateIntoSlot(
  userId: string,
  verseId: string,
  slot: number,
  existing: UserVerse | undefined,
): UserVerse {
  if (!existing) return userVerses.insertIntoSlot(userId, verseId, slot)
  if (existing.needsRelearning) {
    return userVerses.resetForRelearning(existing.id, slot)
  }
  return userVerses.assignSlot(existing.id, slot)
}

/**
 * Fills every empty slot from the front of the practice queue.
 *
 * All 3 slots are live from signup — there is no ramp-up. The queue's default
 * order keeps the old behavior (relearners and swapped-out verses first, then
 * the curriculum), but the user can reorder it, so refill simply takes the
 * top. Called at signup, at the end of POST /api/session/complete, whenever an
 * attempt empties a slot or queues a relearner, and by the queue routes after
 * an explicit slot swap. Returns the verses that took a slot.
 */
export function refillSlots(userId: string): UserVerse[] {
  const occupied = userVerses.occupiedSlots(userId)
  const queue = queueVerseIds(userId)

  const filled: UserVerse[] = []
  let queueIndex = 0

  for (let slot = 1; slot <= MAX_SLOTS; slot += 1) {
    if (occupied.has(slot)) continue

    const verseId = queue[queueIndex]
    queueIndex += 1
    if (!verseId) break

    filled.push(
      activateIntoSlot(
        userId,
        verseId,
        slot,
        userVerses.findByUserAndVerse(userId, verseId),
      ),
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
): { placed: UserVerse; displaced: UserVerse | null } {
  if (!getVerse(verseId)) throw new SlotError('verse not found', 404)
  if (slot < 1 || slot > MAX_SLOTS) throw new SlotError('no such slot', 400)

  const incoming = userVerses.findByUserAndVerse(userId, verseId)
  if (!isQueued(incoming)) {
    throw new SlotError(
      'verse is not available for practice — it is already in a slot or memorized',
      400,
    )
  }

  const displaced = userVerses.findInSlot(userId, slot)
  if (displaced) userVerses.clearSlot(displaced.id)

  const placed = activateIntoSlot(userId, verseId, slot, incoming)
  return {
    placed,
    // Re-read: clearSlot changed it after the copy above was taken.
    displaced: displaced ? userVerses.findById(displaced.id)! : null,
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
