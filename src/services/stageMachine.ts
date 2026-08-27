import { randomUUID } from 'node:crypto';
import {
  db,
  type ExerciseType,
  type ReviewScheduleRow,
  type Stage,
  type UserVerseRow,
} from '../db/client';
import { addDays, todayInTimezone } from '../lib/dates';
import { refillSlots } from './slotRefill';

// ---------------------------------------------------------------------------
// Tuning constants. Change these here, not at the call sites.
// ---------------------------------------------------------------------------

/** Consecutive correct completions needed to advance a learning tier. */
export const TIER_ADVANCE_THRESHOLD = 3;

/** Review interval ladder, in days. A correct review steps one rung up. */
export const INTERVAL_PROGRESSION = [1, 3, 7, 14, 30] as const;
export const MAX_INTERVAL_DAYS = INTERVAL_PROGRESSION[INTERVAL_PROGRESSION.length - 1];

/** Consecutive successful reviews at MAX_INTERVAL_DAYS before `mastered`. */
export const MASTERY_REVIEWS_AT_MAX = 3;

/** Strength below this flags the verse `decayed`; at or above it clears the flag. */
export const DECAY_FLOOR = 20;

/** Strength a verse carries out of learning_heavy. */
export const GRADUATION_STRENGTH = 50;
export const STRENGTH_ON_CORRECT = 10;
export const STRENGTH_ON_INCORRECT = -25;
export const MAX_STRENGTH = 100;

const LEARNING_ORDER: Stage[] = ['learning_light', 'learning_medium', 'learning_heavy'];

export function isLearningStage(stage: Stage): boolean {
  return LEARNING_ORDER.includes(stage);
}

/** Stages that surface in the review queue. */
export function isReviewStage(stage: Stage): boolean {
  return stage === 'review' || stage === 'mastered' || stage === 'decayed';
}

function clampStrength(value: number): number {
  return Math.max(0, Math.min(MAX_STRENGTH, value));
}

/** The next rung up the interval ladder, capped at the top. */
function nextInterval(current: number): number {
  const next = INTERVAL_PROGRESSION.find((days) => days > current);
  return next ?? MAX_INTERVAL_DAYS;
}

function scheduleFor(userVerseId: string): ReviewScheduleRow | undefined {
  return db
    .prepare('SELECT * FROM review_schedule WHERE user_verse_id = ?')
    .get(userVerseId) as ReviewScheduleRow | undefined;
}

function upsertSchedule(userVerseId: string, intervalDays: number, dueAt: string): void {
  const existing = scheduleFor(userVerseId);
  if (existing) {
    db.prepare('UPDATE review_schedule SET due_at = ?, interval_days = ? WHERE id = ?').run(
      dueAt,
      intervalDays,
      existing.id,
    );
    return;
  }
  db.prepare(
    'INSERT INTO review_schedule (id, user_verse_id, due_at, interval_days) VALUES (?, ?, ?, ?)',
  ).run(randomUUID(), userVerseId, dueAt, intervalDays);
}

export interface AttemptOutcome {
  userVerse: UserVerseRow;
  schedule: ReviewScheduleRow | null;
  /** True when this attempt graduated the verse out of learning_heavy. */
  graduated: boolean;
  /** Rows created by the slot refill that graduation triggered. */
  slotsFilled: UserVerseRow[];
}

/**
 * Records one exercise attempt and advances the verse's stage, streak,
 * strength and review schedule.
 *
 * Learning tiers count consecutive correct completions; review stages move
 * along the interval ladder. Runs as a single transaction so a graduation and
 * the slot refill it triggers can't half-apply.
 */
export const recordAttempt = db.transaction(
  (
    userVerse: UserVerseRow,
    exerciseType: ExerciseType,
    correct: boolean,
    timezone: string,
  ): AttemptOutcome => {
    const now = new Date().toISOString();
    const today = todayInTimezone(timezone);

    db.prepare(
      `INSERT INTO attempt (id, user_verse_id, exercise_type, correct, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(randomUUID(), userVerse.id, exerciseType, correct ? 1 : 0, now);

    let { stage, strength, correct_streak_in_tier: streak } = userVerse;
    let slot = userVerse.slot;
    let graduatedAt = userVerse.graduated_at;
    let graduated = false;
    let slotsFilled: UserVerseRow[] = [];

    if (isLearningStage(stage)) {
      // "N consecutive correct" — a miss drops the streak back to zero.
      streak = correct ? streak + 1 : 0;

      if (streak >= TIER_ADVANCE_THRESHOLD) {
        streak = 0;
        const tierIndex = LEARNING_ORDER.indexOf(stage);

        if (tierIndex < LEARNING_ORDER.length - 1) {
          stage = LEARNING_ORDER[tierIndex + 1];
        } else {
          // learning_heavy -> review: empty the slot, stamp the graduation
          // timestamp, and open at interval 1. Graduation is an event recorded
          // in graduated_at, not a regime the verse sits in, so it drops
          // straight into the review rotation.
          stage = 'review';
          slot = null;
          graduatedAt = now;
          strength = GRADUATION_STRENGTH;
          graduated = true;
          upsertSchedule(userVerse.id, 1, addDays(today, 1));
        }
      }
    } else if (correct) {
      const current = scheduleFor(userVerse.id);
      const prevInterval = current?.interval_days ?? 1;
      const interval = nextInterval(prevInterval);

      strength = clampStrength(strength + STRENGTH_ON_CORRECT);

      // Mastery counts consecutive successes accrued *while already at* the
      // top of the ladder, so the four reviews spent climbing don't count.
      streak = prevInterval >= MAX_INTERVAL_DAYS ? streak + 1 : 0;

      if (stage === 'decayed' && strength >= DECAY_FLOOR) {
        stage = 'review';
      }

      if (stage === 'review' && streak >= MASTERY_REVIEWS_AT_MAX) {
        stage = 'mastered';
      }

      upsertSchedule(userVerse.id, interval, addDays(today, interval));
    } else {
      // Missed or incorrect review: back to interval 1, strength down, and
      // flag `decayed` if that drops below the floor.
      strength = clampStrength(strength + STRENGTH_ON_INCORRECT);
      streak = 0;

      if (strength < DECAY_FLOOR) {
        stage = 'decayed';
      } else if (stage === 'mastered') {
        // A failed review contradicts mastery; the interval reset means it is
        // no longer at the top of the ladder either.
        stage = 'review';
      }

      upsertSchedule(userVerse.id, 1, addDays(today, 1));
    }

    db.prepare(
      `UPDATE user_verse
          SET stage = ?, strength = ?, correct_streak_in_tier = ?, slot = ?, graduated_at = ?
        WHERE id = ?`,
    ).run(stage, strength, streak, slot, graduatedAt, userVerse.id);

    if (graduated) {
      // Fill the slot this graduation just emptied.
      slotsFilled = refillSlots(userVerse.user_id);
    }

    return {
      userVerse: db.prepare('SELECT * FROM user_verse WHERE id = ?').get(userVerse.id) as UserVerseRow,
      schedule: scheduleFor(userVerse.id) ?? null,
      graduated,
      slotsFilled,
    };
  },
);
