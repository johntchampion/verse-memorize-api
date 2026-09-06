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
 * What today's session should contain, given the user's verses as they stand
 * at the moment the day is planned. Read exactly once per day — see
 * ensureTodayPlan.
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
      runs.push([
        {
          userVerseId: progress.id,
          queue: 'review',
          instance: 0,
          stage: progress.stage,
        },
      ])
      continue
    }

    if (isLearningStage(progress.stage) && progress.slot !== null) {
      runs.push(
        Array.from({ length: EXERCISES_PER_LEARNING_VERSE }, (_, instance) => ({
          userVerseId: progress.id,
          queue: 'learning' as const,
          instance,
          // Pinned, not read again at render time: all three repetitions are
          // the ones planned this morning, even if the verse changes tier or
          // graduates between the first and the last.
          stage: progress.stage,
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

/**
 * Today's plan, written once on first use and fixed from then on.
 *
 * The day's work is decided by the state at the moment the day is first
 * touched, and nothing that happens afterwards adds to it or takes from it: a
 * verse that graduates mid-session stays in the list, marked done as its
 * repetitions are answered, and the verse that refills the slot behind it waits
 * for tomorrow. Same for a slot the user swaps by hand — the new occupant is
 * drillable straight away through the practice route, which reads the slots
 * live, but the day's own list does not move under a client part-way through
 * it.
 *
 * A day whose desired set comes out empty writes nothing, so it is planned
 * again on the next call rather than being frozen empty — a user with nothing
 * due at midnight still gets a session once a slot is filled.
 */
export const ensureTodayPlan = db.transaction(
  (userId: string, today: string): PlannedExercise[] => {
    const existing = planned.forDay(userId, today)
    if (existing.length > 0) return existing

    const items = desiredItems(userId, today)
    if (items.length === 0) return existing

    planned.create(userId, today, items)
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
