import { getVerse } from '../data/verses'
import { SlotError } from '../lib/errors'
import * as userVerses from '../repositories/userVerseRepository'
import { PracticeQueue } from './PracticeQueue'
import type { UserVerse } from './UserVerse'

/** A user holds at most 3 active learning slots at once. */
export const MAX_SLOTS = 3

export class Slots {
  constructor(private readonly userId: string) {}

  get occupied(): Set<number> {
    return userVerses.occupiedSlots(this.userId)
  }

  /**
   * Fills every empty slot from the front of the practice queue, and returns
   * the verses that took one.
   *
   * All 3 slots are live from signup — there is no ramp-up. Once the queue is
   * exhausted the remaining slots stay empty; there is no wraparound.
   */
  refill(): UserVerse[] {
    const occupied = this.occupied
    const queue = new PracticeQueue(this.userId).verseIds

    const filled: UserVerse[] = []
    let queueIndex = 0

    for (let slot = 1; slot <= MAX_SLOTS; slot += 1) {
      if (occupied.has(slot)) continue

      const verseId = queue[queueIndex]
      queueIndex += 1
      if (!verseId) break

      const existing = userVerses.findByUserAndVerse(this.userId, verseId)
      filled.push(this.activate(verseId, slot, existing))
    }

    return filled
  }

  /**
   * Swaps the occupant of a slot out — progress saved, so it rejoins the queue
   * as an in-progress verse — and puts `verseId` in its place.
   */
  replace(
    verseId: string,
    slot: number,
  ): { placed: UserVerse; displaced: UserVerse | null } {
    if (!getVerse(verseId)) throw new SlotError('verse not found', 404)
    if (slot < 1 || slot > MAX_SLOTS) throw new SlotError('no such slot', 400)

    const incoming = userVerses.findByUserAndVerse(this.userId, verseId)
    if (!PracticeQueue.isQueued(incoming)) {
      throw new SlotError(
        'verse is not available for practice — it is already in a slot or memorized',
        400,
      )
    }

    const displaced = userVerses.findInSlot(this.userId, slot)
    if (displaced) userVerses.clearSlot(displaced.id)

    return {
      placed: this.activate(verseId, slot, incoming),
      // Re-read: clearSlot changed it after the copy above was taken.
      displaced: displaced ? userVerses.findById(displaced.id)! : null,
    }
  }

  /**
   * Puts one queued verse into one empty slot, whatever its state: a relearner
   * re-enters at heavy, a paused verse resumes where it left off, an untouched
   * verse starts at light.
   */
  private activate(
    verseId: string,
    slot: number,
    existing: UserVerse | undefined,
  ): UserVerse {
    if (!existing) {
      return userVerses.insertIntoSlot(this.userId, verseId, slot)
    }
    if (existing.needsRelearning) {
      return userVerses.resetForRelearning(existing.id, slot)
    }
    return userVerses.assignSlot(existing.id, slot)
  }
}
