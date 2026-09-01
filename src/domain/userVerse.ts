/**
 * One user's progress against one verse.
 *
 * This is the shape the services and routes work with. It differs from the
 * `user_verse` row in two ways that matter: the fields are camelCase, and
 * `needsRelearning` is a real boolean rather than SQLite's 0/1. Everything
 * below the repository deals in rows; everything above deals in this.
 *
 * A verse is only ever in one regime at a time, which is why the learning
 * fields and the review fields share one model: `slot` and `streakDate` are
 * populated while learning, `intervalDays` and `dueAt` while reviewing, and
 * each is null in the other regime.
 */
import type { UserVerseRow } from '../db/rows'
import type { Stage } from './stage'

export interface UserVerse {
  id: string
  userId: string
  verseId: string
  stage: Stage

  /** Reset by any answer of the opposite kind. */
  consecutiveCorrect: number
  consecutiveIncorrect: number
  /**
   * Local date `consecutiveCorrect` was accrued on. Learning stages only,
   * where the run has to land inside a single calendar day to count.
   */
  streakDate: string | null

  /** Review and mastered only; null while in a learning slot. */
  intervalDays: number | null
  /** Local date (YYYY-MM-DD). Null means unscheduled. */
  dueAt: string | null

  /** Local dates, capping tier changes at one per day in either direction. */
  lastUpgradeDate: string | null
  lastDowngradeDate: string | null

  /** Pulled out of review, waiting for a learning slot to open. */
  needsRelearning: boolean
  relearningQueuedAt: string | null

  /** 1-3 while held in an active learning slot; null once graduated. */
  slot: number | null
  activatedAt: string
  graduatedAt: string | null
}

/**
 * The fields the progression machine rewrites when an attempt is recorded.
 * Identity and `activatedAt` are excluded because they never change after the
 * verse is first slotted.
 */
export type VerseProgress = Pick<
  UserVerse,
  | 'stage'
  | 'consecutiveCorrect'
  | 'consecutiveIncorrect'
  | 'streakDate'
  | 'intervalDays'
  | 'dueAt'
  | 'lastUpgradeDate'
  | 'lastDowngradeDate'
  | 'needsRelearning'
  | 'relearningQueuedAt'
  | 'slot'
  | 'graduatedAt'
>

export function progressOf(verse: UserVerse): VerseProgress {
  return {
    stage: verse.stage,
    consecutiveCorrect: verse.consecutiveCorrect,
    consecutiveIncorrect: verse.consecutiveIncorrect,
    streakDate: verse.streakDate,
    intervalDays: verse.intervalDays,
    dueAt: verse.dueAt,
    lastUpgradeDate: verse.lastUpgradeDate,
    lastDowngradeDate: verse.lastDowngradeDate,
    needsRelearning: verse.needsRelearning,
    relearningQueuedAt: verse.relearningQueuedAt,
    slot: verse.slot,
    graduatedAt: verse.graduatedAt,
  }
}

export function toUserVerse(row: UserVerseRow): UserVerse {
  return {
    id: row.id,
    userId: row.user_id,
    verseId: row.verse_id,
    stage: row.stage,
    consecutiveCorrect: row.consecutive_correct,
    consecutiveIncorrect: row.consecutive_incorrect,
    streakDate: row.streak_date,
    intervalDays: row.interval_days,
    dueAt: row.due_at,
    lastUpgradeDate: row.last_upgrade_date,
    lastDowngradeDate: row.last_downgrade_date,
    needsRelearning: row.needs_relearning === 1,
    relearningQueuedAt: row.relearning_queued_at,
    slot: row.slot,
    activatedAt: row.activated_at,
    graduatedAt: row.graduated_at,
  }
}

/**
 * The v1 wire shape: a raw `user_verse` row, snake_case, with
 * `needs_relearning` as 0/1.
 *
 * Two endpoints have always serialized the row directly — `POST /api/attempt`
 * and `GET /api/verses/:id` — so clients depend on this exact shape. Naming it
 * a compatibility shim rather than letting the leak continue implicitly means
 * a future API cleanup is one function to change and one name to grep for.
 */
export function legacyUserVerseBody(verse: UserVerse): UserVerseRow {
  return {
    id: verse.id,
    user_id: verse.userId,
    verse_id: verse.verseId,
    stage: verse.stage,
    consecutive_correct: verse.consecutiveCorrect,
    consecutive_incorrect: verse.consecutiveIncorrect,
    streak_date: verse.streakDate,
    interval_days: verse.intervalDays,
    due_at: verse.dueAt,
    last_upgrade_date: verse.lastUpgradeDate,
    last_downgrade_date: verse.lastDowngradeDate,
    needs_relearning: verse.needsRelearning ? 1 : 0,
    relearning_queued_at: verse.relearningQueuedAt,
    slot: verse.slot,
    activated_at: verse.activatedAt,
    graduated_at: verse.graduatedAt,
  }
}
