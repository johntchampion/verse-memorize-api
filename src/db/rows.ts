/**
 * The shapes SQLite hands back, one interface per table.
 *
 * These mirror schema.sql exactly — snake_case columns, integers standing in
 * for booleans — and exist only so the query layer can cast its results. Code
 * above the repository works with the domain models in src/domain/ instead;
 * a row type appearing outside src/db/ is a sign something skipped that
 * boundary.
 */
import type { Stage } from '../domain/stage'

export type ExerciseType = 'tile_fill_blank' | 'type_fill_blank'

export interface UserRow {
  id: string
  email: string
  password_hash: string
  created_at: string
  timezone: string
  translation: string
}

export interface UserVerseRow {
  id: string
  user_id: string
  verse_id: string
  stage: Stage
  consecutive_correct: number
  consecutive_incorrect: number
  streak_date: string | null
  interval_days: number | null
  due_at: string | null
  last_upgrade_date: string | null
  last_downgrade_date: string | null
  /** 0 or 1 — SQLite has no boolean type. */
  needs_relearning: number
  relearning_queued_at: string | null
  slot: number | null
  activated_at: string
  graduated_at: string | null
}

export interface AttemptRow {
  id: string
  user_verse_id: string
  exercise_type: ExerciseType
  /** 0 or 1 — SQLite has no boolean type. */
  correct: number
  created_at: string
}

export interface SessionLogRow {
  id: string
  user_id: string
  completed_at: string
}
