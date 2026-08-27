import { randomUUID } from 'node:crypto';
import { db, type UserVerseRow } from '../db/client';
import { versesInOrder } from '../data/verses';

/** A user holds at most 3 active learning slots at once. */
export const MAX_SLOTS = 3;

/**
 * How many slots are unlocked for this user.
 *
 * Ramp-up is driven by completed sessions, not calendar days: slot 1 at
 * signup, slot 2 once session_log has 1 row, slot 3 once it has 2.
 */
export function unlockedSlotCount(userId: string): number {
  const { n } = db
    .prepare('SELECT COUNT(*) AS n FROM session_log WHERE user_id = ?')
    .get(userId) as { n: number };
  return Math.min(MAX_SLOTS, n + 1);
}

/**
 * The next verse in `order` the user has no user_verse row for, or undefined
 * once the whole bank has been assigned — slots then just stay empty, there is
 * no wraparound in v1.
 */
function nextUnassignedVerseId(userId: string): string | undefined {
  const assigned = new Set(
    (db.prepare('SELECT verse_id FROM user_verse WHERE user_id = ?').all(userId) as {
      verse_id: string;
    }[]).map((r) => r.verse_id),
  );
  return versesInOrder().find((v) => !assigned.has(v.id))?.id;
}

/**
 * Fills every unlocked-but-empty slot with the next verse in order.
 *
 * Called at signup, at the end of POST /api/session/complete (ramp-up), and on
 * graduation when a slot empties. Returns the rows created.
 */
export function refillSlots(userId: string): UserVerseRow[] {
  const unlocked = unlockedSlotCount(userId);

  const occupied = new Set(
    (db
      .prepare('SELECT slot FROM user_verse WHERE user_id = ? AND slot IS NOT NULL')
      .all(userId) as { slot: number }[]).map((r) => r.slot),
  );

  const created: UserVerseRow[] = [];
  const insert = db.prepare(
    `INSERT INTO user_verse
       (id, user_id, verse_id, stage, strength, correct_streak_in_tier, slot, activated_at, graduated_at)
     VALUES (?, ?, ?, 'learning_light', 0, 0, ?, ?, NULL)`,
  );

  for (let slot = 1; slot <= unlocked; slot += 1) {
    if (occupied.has(slot)) continue;

    const verseId = nextUnassignedVerseId(userId);
    if (!verseId) break; // Bank exhausted — leave the slot empty.

    const id = randomUUID();
    insert.run(id, userId, verseId, slot, new Date().toISOString());
    created.push(db.prepare('SELECT * FROM user_verse WHERE id = ?').get(id) as UserVerseRow);
  }

  return created;
}
