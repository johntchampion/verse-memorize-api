import type { UserVerseRow } from '../db/rows'
import { isDue } from '../domain/progression'
import { isLearningStage, isReviewStage, type Stage } from '../domain/stage'

/**
 * A verse is only ever in one regime at a time, which is why the learning and
 * review fields share one model: `slot` and `streakDate` while learning,
 * `intervalDays` and `dueAt` while reviewing, each null in the other.
 */
export interface UserVerseFields {
  id: string
  userId: string
  verseId: string
  stage: Stage

  consecutiveCorrect: number
  consecutiveIncorrect: number
  /** Learning stages only: the run has to land inside one calendar day. */
  streakDate: string | null

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

/** The fields the progression rules rewrite. Identity and activatedAt never change. */
export type VerseProgress = Omit<
  UserVerseFields,
  'id' | 'userId' | 'verseId' | 'activatedAt'
>

export interface UserVerse extends UserVerseFields {}

export class UserVerse {
  constructor(fields: UserVerseFields) {
    Object.assign(this, fields)
  }

  static fromRow(row: UserVerseRow): UserVerse {
    return new UserVerse({
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
    })
  }

  get progress(): VerseProgress {
    return {
      stage: this.stage,
      consecutiveCorrect: this.consecutiveCorrect,
      consecutiveIncorrect: this.consecutiveIncorrect,
      streakDate: this.streakDate,
      intervalDays: this.intervalDays,
      dueAt: this.dueAt,
      lastUpgradeDate: this.lastUpgradeDate,
      lastDowngradeDate: this.lastDowngradeDate,
      needsRelearning: this.needsRelearning,
      relearningQueuedAt: this.relearningQueuedAt,
      slot: this.slot,
      graduatedAt: this.graduatedAt,
    }
  }

  get isSlotted(): boolean {
    return this.slot !== null
  }

  get isLearning(): boolean {
    return isLearningStage(this.stage)
  }

  get isReview(): boolean {
    return isReviewStage(this.stage)
  }

  isDue(today: string): boolean {
    return isDue(this, today)
  }

  tierChangeUsedToday(today: string): boolean {
    return this.lastUpgradeDate === today || this.lastDowngradeDate === today
  }

  /** The v1 wire shape: the raw row, snake_case, `needs_relearning` as 0/1.
      Clients have always received it this way. */
  toLegacyBody(): UserVerseRow {
    return {
      id: this.id,
      user_id: this.userId,
      verse_id: this.verseId,
      stage: this.stage,
      consecutive_correct: this.consecutiveCorrect,
      consecutive_incorrect: this.consecutiveIncorrect,
      streak_date: this.streakDate,
      interval_days: this.intervalDays,
      due_at: this.dueAt,
      last_upgrade_date: this.lastUpgradeDate,
      last_downgrade_date: this.lastDowngradeDate,
      needs_relearning: this.needsRelearning ? 1 : 0,
      relearning_queued_at: this.relearningQueuedAt,
      slot: this.slot,
      activated_at: this.activatedAt,
      graduated_at: this.graduatedAt,
    }
  }
}
