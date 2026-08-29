import { db, type UserVerseRow } from '../db/client';
import { getVerse } from '../data/verses';
import { todayInTimezone } from '../lib/dates';
import { buildExercise, type Exercise } from './exerciseBuilder';
import { isLearningStage, isReviewStage } from './stageMachine';

/**
 * Exercise instances generated per learning verse per session. 2-3 is the
 * intended range — repeating a verse within one session is deliberate.
 */
export const EXERCISES_PER_LEARNING_VERSE = 3;

export interface SessionExercise extends Exercise {
  stage: string;
  /** Which queue the item came from, so the client can label it. */
  queue: 'review' | 'learning';
}

/**
 * Builds today's ordered exercise queue for a user.
 *
 * Review items are due-dated; learning items repeat 2-3x each. The two queues
 * are interleaved round-robin *by verse* so the user never grinds one verse
 * back to back.
 */
export function buildTodaySession(userId: string, timezone: string): SessionExercise[] {
  const today = todayInTimezone(timezone);

  const rows = db
    .prepare('SELECT * FROM user_verse WHERE user_id = ?')
    .all(userId) as UserVerseRow[];

  // One per-verse queue per active verse; each is drained round-robin below.
  const perVerse: SessionExercise[][] = [];

  for (const row of rows) {
    const verse = getVerse(row.verse_id);
    if (!verse) continue; // Verse pulled from the bank; skip rather than 500.

    if (isReviewStage(row.stage)) {
      // A null due_at means unscheduled — a verse queued for relearning sits
      // out of the rotation until a slot picks it up.
      if (!row.due_at || row.due_at > today) continue;
      perVerse.push([
        {
          ...buildExercise(verse, row.id, row.stage),
          stage: row.stage,
          queue: 'review',
        },
      ]);
      continue;
    }

    if (isLearningStage(row.stage) && row.slot !== null) {
      perVerse.push(
        Array.from({ length: EXERCISES_PER_LEARNING_VERSE }, (_, instance) => ({
          ...buildExercise(verse, row.id, row.stage, instance),
          stage: row.stage,
          queue: 'learning' as const,
        })),
      );
    }
  }

  const queue: SessionExercise[] = [];
  const depth = Math.max(0, ...perVerse.map((q) => q.length));
  for (let i = 0; i < depth; i += 1) {
    for (const verseQueue of perVerse) {
      if (i < verseQueue.length) queue.push(verseQueue[i]);
    }
  }

  return queue;
}
