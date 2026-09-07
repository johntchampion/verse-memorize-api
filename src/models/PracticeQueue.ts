import { getTheme } from '../data/themes'
import { versesInOrder } from '../data/verses'
import { QueueError } from '../lib/errors'
import * as queueOrder from '../repositories/queueOrderRepository'
import * as userVerses from '../repositories/userVerseRepository'
import type { UserVerse } from './UserVerse'

/**
 * Every verse the user hasn't memorized and isn't holding in a slot, in the
 * order slot refill will consume them.
 *
 * Membership is derived, never stored. Only the *order* persists, and ids in it
 * that aren't currently queued are skipped on read while queued verses missing
 * from it are merged back in — so a stored order is self-healing: it never
 * blocks a verse from surfacing, and slotting or graduating needs no queue
 * bookkeeping.
 */
export class PracticeQueue {
  constructor(private readonly userId: string) {}

  /** A verse with no row yet has never been started, so it is queued. */
  static isQueued(verse: UserVerse | undefined): boolean {
    if (!verse) return true
    if (verse.needsRelearning) return true
    return verse.isLearning && verse.slot === null
  }

  /**
   * Whether a queued verse has been worked on before — swapped out of a slot,
   * or dropped back for relearning. Having a row at all is what distinguishes
   * the two, since the row is created the moment a verse is first slotted.
   */
  static hasSavedProgress(verse: UserVerse | undefined): boolean {
    return verse !== undefined
  }

  get isCustomized(): boolean {
    return queueOrder.read(this.userId) !== null
  }

  /**
   * Front first. The default order is the curriculum with in-progress verses
   * ahead of untouched ones; a custom order is respected verbatim for the ids
   * it covers, and verses it doesn't mention join at the front when they carry
   * progress and at the back when they are new to the bank.
   */
  get verseIds(): string[] {
    const byVerseId = userVerses.byVerseIdForUser(this.userId)
    const eligible = versesInOrder()
      .filter((verse) => PracticeQueue.isQueued(byVerseId.get(verse.id)))
      .map((verse) => verse.id)
    const carriesProgress = (id: string) =>
      PracticeQueue.hasSavedProgress(byVerseId.get(id))

    const stored = queueOrder.read(this.userId)
    if (!stored) {
      return [
        ...eligible.filter(carriesProgress),
        ...eligible.filter((id) => !carriesProgress(id)),
      ]
    }

    const eligibleIds = new Set(eligible)
    const mentioned = new Set(stored)
    const kept = stored.filter((id) => eligibleIds.has(id))
    const missing = eligible.filter((id) => !mentioned.has(id))
    return [
      ...missing.filter(carriesProgress),
      ...kept,
      ...missing.filter((id) => !carriesProgress(id)),
    ]
  }

  /** 1 = next up, or null when the verse isn't queued. */
  positionOf(verseId: string): number | null {
    const index = this.verseIds.indexOf(verseId)
    return index === -1 ? null : index + 1
  }

  /**
   * Stores a custom order. The ids must all be real bank verses with no
   * duplicates; they need not cover the whole queue, so a slightly stale client
   * cannot corrupt anything.
   */
  setOrder(verseIds: string[]): void {
    const bankIds = new Set(versesInOrder().map((verse) => verse.id))
    const seen = new Set<string>()
    for (const id of verseIds) {
      if (!bankIds.has(id)) throw new QueueError(`unknown verse id "${id}"`)
      if (seen.has(id)) throw new QueueError(`duplicate verse id "${id}"`)
      seen.add(id)
    }
    this.write(verseIds)
  }

  reset(): void {
    queueOrder.remove(this.userId)
  }

  /** The theme's own reading order at the front; everything else keeps its place. */
  moveThemeToTop(themeId: string): void {
    const theme = getTheme(themeId)
    if (!theme) throw new QueueError(`unknown theme "${themeId}"`)

    const current = this.verseIds
    const queued = new Set(current)
    const front = theme.verseIds.filter((id) => queued.has(id))
    const frontSet = new Set(front)
    this.write([...front, ...current.filter((id) => !frontSet.has(id))])
  }

  moveVerseToFront(verseId: string): void {
    const current = this.verseIds
    if (!current.includes(verseId)) {
      throw new QueueError('verse is not in the queue')
    }
    this.write([verseId, ...current.filter((id) => id !== verseId)])
  }

  /**
   * A one-time nudge when a verse drops into relearning, not a standing rule:
   * it becomes an ordinary entry afterwards, free to be moved like anything
   * else. A no-op without a custom order, since the default already surfaces
   * relearners at the front on every read.
   */
  bumpRelearningToFront(verseId: string): void {
    const stored = queueOrder.read(this.userId)
    if (!stored || stored[0] === verseId) return
    this.write([verseId, ...stored.filter((id) => id !== verseId)])
  }

  private write(verseIds: string[]): void {
    queueOrder.write(this.userId, verseIds, new Date().toISOString())
  }
}
