import type { UserVerseRow } from '../db/client'
import * as userVerses from '../repositories/userVerseRepository'
import { DEFAULT_TRANSLATION, getVerse } from '../data/verses'
import type { SessionQueue } from '../domain/sessionExercise'
import type { Stage } from '../domain/stage'
import type { UserVerse } from '../domain/userVerse'
import { legacyUserVerseBody } from '../domain/userVerse'
import { todayInTimezone } from '../lib/dates'
import { buildExercise, type Exercise } from './exerciseBuilder'
import { ensureTodayPlan } from './sessionPlan'

export interface SessionExercise extends Exercise {
  /**
   * The stage this exercise was built at — for the day's session, the one
   * pinned when the day was planned, which may no longer be the stage
   * `userVerse` reports.
   */
  stage: Stage
  /** Which queue the item came from, so the client can label it. */
  queue: SessionQueue
  /** Whether this exercise has already been answered today. */
  completed: boolean
  /**
   * How it was answered, or null while outstanding. Lets a client that resumed
   * a session report the whole day's tally rather than only the part of it that
   * happened in front of it.
   */
  correct: boolean | null
  /** The verse's current progress, in the same shape POST /api/attempt returns. */
  userVerse: UserVerseRow
}

/**
 * Renders one exercise at the stage the caller names.
 *
 * Blanks are regenerated from `verseId:stage:instance` rather than stored, so
 * a slot rebuilds identically on every read as long as it is asked for at the
 * same stage. Which stage that is differs by caller: the day's session passes
 * the stage pinned when the day was planned, a drill passes the verse's live
 * one.
 *
 * `userVerse` carries the verse's progress as it stands *now* regardless, so a
 * client still sees a graduation the moment it happens — it just doesn't see
 * the exercises behind it change difficulty because of it.
 */
function render(
  progress: UserVerse,
  translation: string,
  stage: Stage,
  queue: SessionQueue,
  instance: number,
  completed: boolean,
  correct: boolean | null,
): SessionExercise | null {
  const verse = getVerse(progress.verseId, translation)
  if (!verse) return null // Verse pulled from the bank; skip rather than 500.

  return {
    ...buildExercise(verse, progress.id, stage, instance),
    stage,
    queue,
    completed,
    correct,
    userVerse: legacyUserVerseBody(progress),
  }
}

/**
 * Today's ordered exercise queue, resumable: the contents and the order are
 * both settled when the day is first opened, right down to each exercise's
 * difficulty, and each item says whether it has been answered — so a client
 * that quit mid-session picks up where it stopped instead of starting over,
 * and finds the same list it left, even if a verse graduated or a slot changed
 * hands in the meantime.
 */
export function buildTodaySession(
  userId: string,
  timezone: string,
  translation: string = DEFAULT_TRANSLATION,
): SessionExercise[] {
  const today = todayInTimezone(timezone)
  const plan = ensureTodayPlan(userId, today)
  const byId = new Map(userVerses.allForUser(userId).map((v) => [v.id, v]))

  const session: SessionExercise[] = []
  for (const item of plan) {
    const progress = byId.get(item.userVerseId)
    if (!progress) continue // Verse deleted out from under the plan.
    const exercise = render(
      progress,
      translation,
      // Null only for a day planned before stages were pinned; those rows keep
      // the old live-stage behaviour until the day rolls over.
      item.stage ?? progress.stage,
      item.queue,
      item.instance,
      item.completed,
      item.correct,
    )
    if (exercise) session.push(exercise)
  }
  return session
}

/**
 * A short drill: one exercise per verse currently in a learning slot.
 *
 * For practice outside the day's lesson, so it neither reads nor writes the
 * day's plan — nothing here counts toward finishing the session. This is also
 * where a slot change shows up immediately: the drill is built from whatever is
 * slotted at the moment it is asked for, while the day's session stays as it
 * was planned. Because it is meant to be used repeatedly through the day, the
 * instance is random rather than sequential: this is the one place the
 * deterministic seed is given up on purpose, so two drills in a row don't blank
 * the same words.
 */
export function buildPracticeSession(
  userId: string,
  translation: string = DEFAULT_TRANSLATION,
): SessionExercise[] {
  const session: SessionExercise[] = []
  // slottedForUser orders by slot, so the drill order is stable within a call
  // even though the blanks are not.
  for (const progress of userVerses.slottedForUser(userId)) {
    const exercise = render(
      progress,
      translation,
      progress.stage,
      'learning',
      Math.floor(Math.random() * 1_000_000),
      false,
      null,
    )
    if (exercise) session.push(exercise)
  }
  return session
}
