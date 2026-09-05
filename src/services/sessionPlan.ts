import { db } from '../db/client'
import * as planned from '../db/sessionExerciseRepository'
import type { NewPlanItem } from '../db/sessionExerciseRepository'
import * as userVerses from '../db/userVerseRepository'
import { isDue } from '../domain/progression'
import type { PlannedExercise } from '../domain/sessionExercise'
import { isLearningStage, isReviewStage } from '../domain/stage'

/**
 * Exercise instances generated per learning verse per session. 2-3 is the
 * intended range — repeating a verse within one session is deliberate.
 */
export const EXERCISES_PER_LEARNING_VERSE = 3

/**
 * What today's session should contain, given the user's verses right now.
 *
 * Deliberately never touches the verse bank: verse_id is translation-
 * independent, so a plan built while reading one translation is valid for
 * every other. A verse missing from the bank is dropped at render time
 * instead — see sessionBuilder.
 */
function desiredItems(userId: string, today: string): NewPlanItem[] {
  // Each active verse contributes its own run of exercises; the runs are
  // drained round-robin below so no verse is drilled back to back.
  const runs: NewPlanItem[][] = []

  for (const progress of userVerses.allForUser(userId)) {
    if (isReviewStage(progress.stage)) {
      // The same predicate the progression rules use to decide whether an
      // answer counts, so a verse is never served an exercise that can't move
      // its schedule. A null dueAt means unscheduled — a verse queued for
      // relearning sits out of the rotation until a slot picks it up.
      if (!isDue(progress, today)) continue
      runs.push([{ userVerseId: progress.id, queue: 'review', instance: 0 }])
      continue
    }

    if (isLearningStage(progress.stage) && progress.slot !== null) {
      runs.push(
        Array.from({ length: EXERCISES_PER_LEARNING_VERSE }, (_, instance) => ({
          userVerseId: progress.id,
          queue: 'learning' as const,
          instance,
        })),
      )
    }
  }

  const items: NewPlanItem[] = []
  const longestRun = Math.max(0, ...runs.map((run) => run.length))
  for (let i = 0; i < longestRun; i += 1) {
    for (const run of runs) {
      if (i < run.length) items.push(run[i])
    }
  }

  return items
}

/** The identity of a plan slot, as stored by the UNIQUE constraint. */
function key(item: { userVerseId: string; queue: string; instance: number }) {
  return `${item.userVerseId}|${item.queue}|${item.instance}`
}

/**
 * Today's plan, creating it on first use and topping it up thereafter.
 *
 * Append-only within a day. Anything already planned keeps its position even
 * once it stops being "due" — an answered review or a graduated verse stays in
 * the list, marked done, instead of vanishing out from under the client. New
 * work does show up: a slot refilled mid-session lands at the tail, which is
 * how it has always behaved, just without reshuffling what came before.
 */
export const ensureTodayPlan = db.transaction(
  (userId: string, today: string): PlannedExercise[] => {
    const existing = planned.forDay(userId, today)
    const seen = new Set(existing.map(key))
    const missing = desiredItems(userId, today).filter(
      (item) => !seen.has(key(item)),
    )
    if (missing.length === 0) return existing

    planned.append(userId, today, missing, existing.length)
    return planned.forDay(userId, today)
  },
)

/**
 * Records that one exercise for this verse has been answered. Returns false
 * when the verse has nothing outstanding today, which is the normal case for
 * extra practice done after the day's session.
 */
export function completeNextForVerse(
  userId: string,
  today: string,
  userVerseId: string,
  now: string,
  correct: boolean,
): boolean {
  return planned.completeNext(userId, today, userVerseId, now, correct)
}

/** Drops every plan older than `today` for this user. */
export function pruneBefore(userId: string, today: string): void {
  planned.pruneBefore(userId, today)
}
