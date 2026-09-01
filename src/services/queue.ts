import { db, type UserVerseRow } from '../db/client'
import { getTheme } from '../data/themes'
import { versesInOrder } from '../data/verses'

/**
 * The practice queue: every verse the user hasn't memorized and isn't holding
 * in a slot right now, in the order slot refill will consume them.
 *
 * Membership is derived, never stored — a verse is queued when it has no
 * user_verse row yet (never started), when it has been pulled out of review
 * for relearning, or when it is mid-learning but was swapped out of its slot
 * (progress saved, waiting to resume). Only the *order* persists, as a JSON
 * array of verse ids in user_queue; ids in it that aren't currently queued are
 * skipped on read, and queued verses missing from it are merged back in. That
 * makes a stored order self-healing: it never blocks a verse from surfacing,
 * and slotting or graduating a verse needs no queue bookkeeping.
 */

/** Local duplicate of stageMachine's check, kept here to avoid an import
    cycle (stageMachine → slotRefill → queue). */
function inLearning(row: UserVerseRow): boolean {
  return (
    row.stage === 'learning_light' ||
    row.stage === 'learning_medium' ||
    row.stage === 'learning_heavy'
  )
}

/** Whether a verse (by its row, if any) currently belongs in the queue. */
export function isQueued(row: UserVerseRow | undefined): boolean {
  if (!row) return true
  if (row.needs_relearning === 1) return true
  return inLearning(row) && row.slot === null
}

/** True for a queued verse that carries saved progress rather than being
    untouched — it re-enters practice where it left off. */
export function isInProgress(row: UserVerseRow | undefined): boolean {
  return row !== undefined && isQueued(row)
}

export function rowsByVerseId(userId: string): Map<string, UserVerseRow> {
  return new Map(
    (
      db
        .prepare('SELECT * FROM user_verse WHERE user_id = ?')
        .all(userId) as UserVerseRow[]
    ).map((row) => [row.verse_id, row]),
  )
}

function storedOrder(userId: string): string[] | null {
  const row = db
    .prepare('SELECT verse_order FROM user_queue WHERE user_id = ?')
    .get(userId) as { verse_order: string } | undefined
  if (!row) return null
  try {
    const parsed: unknown = JSON.parse(row.verse_order)
    return Array.isArray(parsed)
      ? parsed.filter((v) => typeof v === 'string')
      : null
  } catch {
    return null
  }
}

function writeOrder(userId: string, verseIds: string[]): void {
  db.prepare(
    `INSERT INTO user_queue (user_id, verse_order, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE
       SET verse_order = excluded.verse_order, updated_at = excluded.updated_at`,
  ).run(userId, JSON.stringify(verseIds), new Date().toISOString())
}

/** Whether this user has customized the order (vs. the default). */
export function hasCustomOrder(userId: string): boolean {
  return storedOrder(userId) !== null
}

/**
 * The queue as verse ids, front (next to enter a slot) first.
 *
 * Default order is the curriculum, with one twist: queued verses that carry
 * progress (relearners, swapped-out slots) come before untouched ones — they
 * were already on their way in, so they resume first. That preserves the old
 * relearner-priority refill behavior while making it visible and overridable.
 *
 * A custom order is respected verbatim for the ids it covers; queued verses it
 * doesn't mention join at the front when they carry progress and at the back
 * when they're new to the bank. A verse that drops into relearning gets one
 * nudge to the front of a custom order, at the moment it happens (see
 * `bumpRelearningToFront`) — after that it's just another id in the order,
 * free to be moved like anything else.
 */
export function queueVerseIds(userId: string): string[] {
  const rows = rowsByVerseId(userId)
  const eligible = versesInOrder().filter((v) => isQueued(rows.get(v.id)))
  const inProgress = (id: string) => isInProgress(rows.get(id))

  const stored = storedOrder(userId)
  if (!stored) {
    const ids = eligible.map((v) => v.id)
    return [...ids.filter(inProgress), ...ids.filter((id) => !inProgress(id))]
  }

  const eligibleIds = new Set(eligible.map((v) => v.id))
  const mentioned = new Set(stored)
  const kept = stored.filter((id) => eligibleIds.has(id))
  const missing = eligible.map((v) => v.id).filter((id) => !mentioned.has(id))
  return [
    ...missing.filter(inProgress),
    ...kept,
    ...missing.filter((id) => !inProgress(id)),
  ]
}

/**
 * Called the moment a verse drops into relearning: if the user has a custom
 * order, splices the verse to the front of it — a one-time nudge, not a
 * standing rule. It becomes an ordinary entry in the stored order from then
 * on, so the user is free to move it (or anything else) afterward. A no-op
 * without a custom order, since the default computation above already
 * surfaces relearners at the front on every read.
 */
export function bumpRelearningToFront(userId: string, verseId: string): void {
  const stored = storedOrder(userId)
  if (!stored || stored[0] === verseId) return
  writeOrder(userId, [verseId, ...stored.filter((id) => id !== verseId)])
}

/**
 * Stores a custom order. The ids must all be real bank verses with no
 * duplicates; they don't have to cover the whole queue (read-side merging
 * handles the rest), so a slightly stale client can't corrupt anything.
 */
export function setQueueOrder(userId: string, verseIds: string[]): void {
  const bankIds = new Set(versesInOrder().map((v) => v.id))
  const seen = new Set<string>()
  for (const id of verseIds) {
    if (!bankIds.has(id)) throw new QueueError(`unknown verse id "${id}"`)
    if (seen.has(id)) throw new QueueError(`duplicate verse id "${id}"`)
    seen.add(id)
  }
  writeOrder(userId, verseIds)
}

/** Back to the default order. */
export function resetQueueOrder(userId: string): void {
  db.prepare('DELETE FROM user_queue WHERE user_id = ?').run(userId)
}

/**
 * Moves every queued verse of a theme to the front, in the theme's own
 * reading order. Everything else keeps its relative place behind them.
 */
export function moveThemeToTop(userId: string, themeId: string): void {
  const theme = getTheme(themeId)
  if (!theme) throw new QueueError(`unknown theme "${themeId}"`)

  const current = queueVerseIds(userId)
  const queued = new Set(current)
  const front = theme.verseIds.filter((id) => queued.has(id))
  const frontSet = new Set(front)
  writeOrder(userId, [...front, ...current.filter((id) => !frontSet.has(id))])
}

/** Moves one queued verse to the front — the next-up spot. */
export function moveVerseToFront(userId: string, verseId: string): void {
  const current = queueVerseIds(userId)
  if (!current.includes(verseId)) {
    throw new QueueError('verse is not in the queue')
  }
  writeOrder(userId, [verseId, ...current.filter((id) => id !== verseId)])
}

/** Invalid queue input — routes map it to a 400/404 rather than a 500. */
export class QueueError extends Error {}
