import type { UserVerseRow } from '../db/client'
import * as userVerses from '../db/userVerseRepository'
import { DEFAULT_TRANSLATION, getVerse } from '../data/verses'
import type { SessionQueue } from '../domain/sessionExercise'
import type { UserVerse } from '../domain/userVerse'
import { legacyUserVerseBody } from '../domain/userVerse'
import { todayInTimezone } from '../lib/dates'
import { buildExercise, type Exercise } from './exerciseBuilder'
import { ensureTodayPlan } from './sessionPlan'

export interface SessionExercise extends Exercise {
  stage: string
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
 * Renders one planned slot.
 *
 * Stage comes from the verse as it stands *now*, not from when the day was
 * planned: a verse that upgrades a tier partway through the session should get
 * harder repetitions for the rest of it. Blanks are regenerated from
 * `verseId:stage:instance`, so the same slot rebuilds identically for as long
 * as the stage holds — and where it doesn't, only which words are blanked
 * changes, never the queue or the order.
 */
function render(
  progress: UserVerse,
  translation: string,
  queue: SessionQueue,
  instance: number,
  completed: boolean,
  correct: boolean | null,
): SessionExercise | null {
  const verse = getVerse(progress.verseId, translation)
  if (!verse) return null // Verse pulled from the bank; skip rather than 500.

  return {
    ...buildExercise(verse, progress.id, progress.stage, instance),
    stage: progress.stage,
    queue,
    completed,
    correct,
    userVerse: legacyUserVerseBody(progress),
  }
}

/**
 * Today's ordered exercise queue, resumable: the order is fixed for the day
 * and each item says whether it has been answered, so a client that quit
 * mid-session picks up where it stopped instead of starting over.
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
 * day's plan — nothing here counts toward finishing the session. Because it is
 * meant to be used repeatedly through the day, the instance is random rather
 * than sequential: this is the one place the deterministic seed is given up on
 * purpose, so two drills in a row don't blank the same words.
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
      'learning',
      Math.floor(Math.random() * 1_000_000),
      false,
      null,
    )
    if (exercise) session.push(exercise)
  }
  return session
}
