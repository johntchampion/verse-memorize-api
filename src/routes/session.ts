import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { db, type SessionLogRow, type UserRow, type UserVerseRow } from '../db/client';
import { todayInTimezone } from '../lib/dates';
import { userId } from '../middleware/auth';
import { buildTodaySession } from '../services/sessionBuilder';
import { refillSlots } from '../services/slotRefill';
import { recordAttempt } from '../services/stageMachine';

export const sessionRouter = Router();

function timezoneFor(id: string): string {
  const user = db.prepare('SELECT timezone FROM users WHERE id = ?').get(id) as
    | Pick<UserRow, 'timezone'>
    | undefined;
  return user?.timezone ?? 'UTC';
}

/** Today's ordered exercise queue. */
sessionRouter.get('/session/today', (req, res) => {
  const id = userId(req);
  const exercises = buildTodaySession(id, timezoneFor(id));
  res.json({ exercises, count: exercises.length });
});

const attemptBody = z.object({
  userVerseId: z.uuid(),
  exerciseType: z.enum(['tile_fill_blank', 'type_fill_blank']),
  correct: z.boolean(),
});

/**
 * Records one attempt and returns the updated user_verse so the client can
 * reflect stage changes immediately.
 */
sessionRouter.post('/attempt', (req, res) => {
  const id = userId(req);
  const parsed = attemptBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body', details: z.treeifyError(parsed.error) });
    return;
  }

  const userVerse = db
    .prepare('SELECT * FROM user_verse WHERE id = ? AND user_id = ?')
    .get(parsed.data.userVerseId, id) as UserVerseRow | undefined;

  if (!userVerse) {
    res.status(404).json({ error: 'user_verse not found' });
    return;
  }

  const outcome = recordAttempt(
    userVerse,
    parsed.data.exerciseType,
    parsed.data.correct,
    timezoneFor(id),
  );

  res.json(outcome);
});

/**
 * Marks the daily session complete and runs the slot ramp-up check.
 * Idempotent per calendar day in the user's timezone.
 */
sessionRouter.post('/session/complete', (req, res) => {
  const id = userId(req);
  const timezone = timezoneFor(id);
  const today = todayInTimezone(timezone);

  // completed_at is a UTC instant, so "already logged today" is decided by
  // rendering recent rows back into the user's local date.
  const recent = db
    .prepare('SELECT * FROM session_log WHERE user_id = ? ORDER BY completed_at DESC LIMIT 10')
    .all(id) as SessionLogRow[];

  const alreadyLogged = recent.some(
    (row) => todayInTimezone(timezone, new Date(row.completed_at)) === today,
  );

  if (!alreadyLogged) {
    db.prepare('INSERT INTO session_log (id, user_id, completed_at) VALUES (?, ?, ?)').run(
      randomUUID(),
      id,
      new Date().toISOString(),
    );
  }

  // Runs either way: a refill that failed earlier (bank exhausted, slot freed
  // between calls) should still get picked up on a repeat call.
  const slotsFilled = refillSlots(id);

  const { n } = db
    .prepare('SELECT COUNT(*) AS n FROM session_log WHERE user_id = ?')
    .get(id) as { n: number };

  res.json({ recorded: !alreadyLogged, sessionsCompleted: n, slotsFilled });
});
