/**
 * Every `user_verse` query, in one place, returning domain models.
 *
 * These statements used to be written inline at a dozen call sites across the
 * routes and services, each with its own `as UserVerseRow` cast and three of
 * them character-for-character identical. Collecting them here means a column
 * rename touches one file, and callers above this boundary never see a row.
 *
 * Statements are prepared per call rather than at module load: this module is
 * imported before migrate() has created the tables.
 */
import { randomUUID } from 'node:crypto'
import { db } from './client'
import type { UserVerseRow } from './rows'
import {
  toUserVerse,
  type UserVerse,
  type VerseProgress,
} from '../domain/userVerse'

function one(sql: string, ...params: unknown[]): UserVerse | undefined {
  const row = db.prepare(sql).get(...params) as UserVerseRow | undefined
  return row ? toUserVerse(row) : undefined
}

function many(sql: string, ...params: unknown[]): UserVerse[] {
  const rows = db.prepare(sql).all(...params) as UserVerseRow[]
  return rows.map(toUserVerse)
}

export function findById(id: string): UserVerse | undefined {
  return one('SELECT * FROM user_verse WHERE id = ?', id)
}

/** Scoped to the user, so one account cannot address another's row. */
export function findByIdForUser(
  id: string,
  userId: string,
): UserVerse | undefined {
  return one(
    'SELECT * FROM user_verse WHERE id = ? AND user_id = ?',
    id,
    userId,
  )
}

export function findByUserAndVerse(
  userId: string,
  verseId: string,
): UserVerse | undefined {
  return one(
    'SELECT * FROM user_verse WHERE user_id = ? AND verse_id = ?',
    userId,
    verseId,
  )
}

/** Every verse this user has started, in no particular order. */
export function allForUser(userId: string): UserVerse[] {
  return many('SELECT * FROM user_verse WHERE user_id = ?', userId)
}

/** Keyed by verse id — the lookup callers most often want. */
export function byVerseIdForUser(userId: string): Map<string, UserVerse> {
  return new Map(allForUser(userId).map((verse) => [verse.verseId, verse]))
}

/** The verses currently held in learning slots, slot ascending. */
export function slottedForUser(userId: string): UserVerse[] {
  return many(
    'SELECT * FROM user_verse WHERE user_id = ? AND slot IS NOT NULL ORDER BY slot',
    userId,
  )
}

export function findInSlot(
  userId: string,
  slot: number,
): UserVerse | undefined {
  return one(
    'SELECT * FROM user_verse WHERE user_id = ? AND slot = ?',
    userId,
    slot,
  )
}

export function countForUser(userId: string): number {
  const { total } = db
    .prepare('SELECT COUNT(*) AS total FROM user_verse WHERE user_id = ?')
    .get(userId) as { total: number }
  return total
}

export function occupiedSlots(userId: string): Set<number> {
  const rows = db
    .prepare(
      'SELECT slot FROM user_verse WHERE user_id = ? AND slot IS NOT NULL',
    )
    .all(userId) as { slot: number }[]
  return new Set(rows.map((row) => row.slot))
}

/** Writes the progression fields back. Identity and activatedAt are untouched. */
export function saveProgress(id: string, progress: VerseProgress): void {
  db.prepare(
    `UPDATE user_verse
        SET stage = ?,
            consecutive_correct = ?,
            consecutive_incorrect = ?,
            streak_date = ?,
            interval_days = ?,
            due_at = ?,
            last_upgrade_date = ?,
            last_downgrade_date = ?,
            needs_relearning = ?,
            relearning_queued_at = ?,
            slot = ?,
            graduated_at = ?
      WHERE id = ?`,
  ).run(
    progress.stage,
    progress.consecutiveCorrect,
    progress.consecutiveIncorrect,
    progress.streakDate,
    progress.intervalDays,
    progress.dueAt,
    progress.lastUpgradeDate,
    progress.lastDowngradeDate,
    progress.needsRelearning ? 1 : 0,
    progress.relearningQueuedAt,
    progress.slot,
    progress.graduatedAt,
    id,
  )
}

/** Starts a verse the user has never practiced, at the easiest tier. */
export function insertIntoSlot(
  userId: string,
  verseId: string,
  slot: number,
): UserVerse {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO user_verse (id, user_id, verse_id, stage, slot, activated_at)
     VALUES (?, ?, ?, 'learning_light', ?, ?)`,
  ).run(id, userId, verseId, slot, new Date().toISOString())
  return findById(id)!
}

/**
 * Re-seats a relearner at learning_heavy with its counters and schedule wiped.
 * Never a lower tier: the verse was known well enough to reach review once.
 */
export function resetForRelearning(id: string, slot: number): UserVerse {
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
  ).run(slot, id)
  return findById(id)!
}

/** Puts a paused verse back in a slot with its tier and history intact. */
export function assignSlot(id: string, slot: number): UserVerse {
  db.prepare('UPDATE user_verse SET slot = ? WHERE id = ?').run(slot, id)
  return findById(id)!
}

/** Frees a slot, leaving the verse's progress in place. */
export function clearSlot(id: string): void {
  db.prepare('UPDATE user_verse SET slot = NULL WHERE id = ?').run(id)
}
