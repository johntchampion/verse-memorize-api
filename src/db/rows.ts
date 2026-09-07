/**
 * The shapes SQLite hands back, mirroring schema.sql. A row type outside
 * src/db/ and src/repositories/ is a sign something skipped the boundary.
 */
import type { SessionEventKind } from '../domain/sessionEvent'
import type { SessionQueue } from '../domain/sessionExercise'
import type { Stage } from '../domain/stage'

/** SQLite has no boolean type. */
export type SqliteBool = 0 | 1

export const EXERCISE_TYPES = ['tile_fill_blank', 'type_fill_blank'] as const
export type ExerciseType = (typeof EXERCISE_TYPES)[number]

export interface UserRow {
  id: string
  email: string
  password_hash: string
  created_at: string
  timezone: string
  translation: string
  reminders_enabled: SqliteBool
  /** Local date (YYYY-MM-DD) the last daily reminder was claimed for, in this
      user's timezone; NULL until the first one goes out. */
  reminder_last_sent_date: string | null
  /** Carried in every JWT as `tv`. A password reset bumps it, revoking every
      token minted before. */
  token_version: number
}

/** A reset in flight. `token_hash` is the sha256 of what the email carried —
    the raw token exists only in that email. */
export interface PasswordResetRow {
  id: string
  user_id: string
  token_hash: string
  created_at: string
  expires_at: string
  /** Set when redeemed, and when superseded by a newer request. */
  used_at: string | null
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
  needs_relearning: SqliteBool
  relearning_queued_at: string | null
  slot: number | null
  activated_at: string
  graduated_at: string | null
}

export interface AttemptRow {
  id: string
  user_verse_id: string
  exercise_type: ExerciseType
  correct: SqliteBool
  created_at: string
}

export interface SessionLogRow {
  id: string
  user_id: string
  completed_at: string
}

export interface SessionExerciseRow {
  id: string
  user_id: string
  /** Local date (YYYY-MM-DD) in the user's timezone. */
  session_date: string
  position: number
  user_verse_id: string
  queue: SessionQueue
  instance: number
  /** The stage the exercise was planned at; NULL for rows planned before it
      was pinned, which fall back to the verse's current stage. */
  stage: Stage | null
  /** ISO 8601, or NULL while the exercise is still outstanding. */
  completed_at: string | null
  /** NULL while outstanding, or if it was answered
      before this column existed. */
  correct: number | null
}

export interface SessionEventRow {
  id: string
  user_id: string
  /** Local date (YYYY-MM-DD) in the user's timezone. */
  session_date: string
  created_at: string
  kind: SessionEventKind
  user_verse_id: string
  verse_id: string
  /** NULL for slot events, which are not a move along the ladder. */
  stage_from: Stage | null
  stage_to: Stage | null
  /** The slot taken, for slot events; NULL otherwise. */
  slot: number | null
}

export interface PushSubscriptionRow {
  id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth: string
  user_agent: string | null
  created_at: string
}
