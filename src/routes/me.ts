import { Router } from 'express';
import { z } from 'zod';
import { db, type SessionLogRow, type UserRow, type UserVerseRow } from '../db/client';
import { getVerse } from '../data/verses';
import { addDays, todayInTimezone } from '../lib/dates';
import { userId } from '../middleware/auth';
import { MAX_SLOTS, unlockedSlotCount } from '../services/slotRefill';

export const meRouter = Router();

/**
 * Consecutive days ending today (or yesterday, if today's session isn't done
 * yet) that have a session_log row, counted in the user's local dates.
 */
function currentStreak(rows: SessionLogRow[], timezone: string): number {
  const days = new Set(rows.map((r) => todayInTimezone(timezone, new Date(r.completed_at))));
  const today = todayInTimezone(timezone);

  // An unfinished today shouldn't zero out a streak that's still alive.
  let cursor = days.has(today) ? today : addDays(today, -1);

  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/** The GET /api/me response body, shared with PATCH so both return one shape. */
function profileFor(id: string) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  if (!user) return null;

  const sessions = db
    .prepare('SELECT * FROM session_log WHERE user_id = ? ORDER BY completed_at DESC')
    .all(id) as SessionLogRow[];

  const active = db
    .prepare('SELECT * FROM user_verse WHERE user_id = ? AND slot IS NOT NULL ORDER BY slot')
    .all(id) as UserVerseRow[];

  const { total } = db
    .prepare('SELECT COUNT(*) AS total FROM user_verse WHERE user_id = ?')
    .get(id) as { total: number };

  return {
    user: { id: user.id, email: user.email, timezone: user.timezone, createdAt: user.created_at },
    streak: currentStreak(sessions, user.timezone),
    sessionsCompleted: sessions.length,
    versesStarted: total,
    slots: {
      max: MAX_SLOTS,
      unlocked: unlockedSlotCount(id),
      active: active.map((row) => ({
        slot: row.slot,
        userVerseId: row.id,
        verseId: row.verse_id,
        reference: getVerse(row.verse_id)?.reference ?? null,
        stage: row.stage,
        correctStreakInTier: row.correct_streak_in_tier,
      })),
    },
  };
}

/** Profile, streak and slot state. */
meRouter.get('/me', (req, res) => {
  const profile = profileFor(userId(req));
  if (!profile) {
    res.status(404).json({ error: 'user not found' });
    return;
  }
  res.json(profile);
});

const patchBody = z.object({ timezone: z.string().min(1) });

/** True when `Intl` recognises the timezone — the same check dates.ts relies on. */
function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Updates profile settings — timezone only for now. It drives every
 * day-boundary calculation (streaks, due dates, session idempotency).
 */
meRouter.patch('/me', (req, res) => {
  const id = userId(req);
  const parsed = patchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body', details: z.treeifyError(parsed.error) });
    return;
  }
  if (!isValidTimezone(parsed.data.timezone)) {
    res.status(400).json({ error: 'unknown timezone' });
    return;
  }

  const result = db.prepare('UPDATE users SET timezone = ? WHERE id = ?').run(parsed.data.timezone, id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'user not found' });
    return;
  }

  res.json(profileFor(id));
});
