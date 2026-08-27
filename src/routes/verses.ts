import { Router } from 'express';
import {
  db,
  type AttemptRow,
  type ReviewScheduleRow,
  type Stage,
  type UserVerseRow,
} from '../db/client';
import { getVerse, versesInCanonOrder, versesInOrder } from '../data/verses';
import { userId } from '../middleware/auth';

export const versesRouter = Router();

/** Browse-screen status for a verse. */
type VerseStatus = 'locked' | 'active' | 'review' | 'mastered';

function statusFor(stage: Stage | undefined): VerseStatus {
  switch (stage) {
    case undefined:
      return 'locked';
    case 'learning_light':
    case 'learning_medium':
    case 'learning_heavy':
      return 'active';
    case 'mastered':
      return 'mastered';
    // `decayed` is a flagged variant of review, not its own browse status —
    // callers read the `decayed` boolean alongside it.
    case 'review':
    case 'decayed':
      return 'review';
  }
}

/** The full bank with per-user status. */
versesRouter.get('/verses', (req, res) => {
  const id = userId(req);
  const byVerseId = new Map(
    (db.prepare('SELECT * FROM user_verse WHERE user_id = ?').all(id) as UserVerseRow[]).map(
      (row) => [row.verse_id, row],
    ),
  );

  // `orderBy=canon` returns Bible order (Genesis through Revelation);
  // anything else (including omitted) keeps the curriculum order.
  const bank = req.query.orderBy === 'canon' ? versesInCanonOrder() : versesInOrder();

  const verses = bank.map((verse) => {
    const row = byVerseId.get(verse.id);
    return {
      id: verse.id,
      reference: verse.reference,
      order: verse.order,
      status: statusFor(row?.stage),
      stage: row?.stage ?? null,
      decayed: row?.stage === 'decayed',
      strength: row?.strength ?? 0,
      slot: row?.slot ?? null,
      // Graduation is an achievement the UI can badge, not a status of its own.
      graduatedAt: row?.graduated_at ?? null,
      // Locked verses withhold the text — that is the point of the browse
      // screen's lock state.
      text: row ? verse.text : null,
    };
  });

  res.json({ verses });
});

/** Single verse detail plus this user's history. */
versesRouter.get('/verses/:id', (req, res) => {
  const id = userId(req);
  const verse = getVerse(req.params.id);
  if (!verse) {
    res.status(404).json({ error: 'verse not found' });
    return;
  }

  const row = db
    .prepare('SELECT * FROM user_verse WHERE user_id = ? AND verse_id = ?')
    .get(id, verse.id) as UserVerseRow | undefined;

  const attempts = row
    ? (db
        .prepare('SELECT * FROM attempt WHERE user_verse_id = ? ORDER BY created_at DESC LIMIT 100')
        .all(row.id) as AttemptRow[])
    : [];

  const schedule = row
    ? (db
        .prepare('SELECT * FROM review_schedule WHERE user_verse_id = ?')
        .get(row.id) as ReviewScheduleRow | undefined) ?? null
    : null;

  res.json({
    verse: {
      id: verse.id,
      reference: verse.reference,
      order: verse.order,
      text: row ? verse.text : null,
    },
    status: statusFor(row?.stage),
    graduatedAt: row?.graduated_at ?? null,
    userVerse: row ?? null,
    schedule,
    history: {
      attempts,
      total: attempts.length,
      correct: attempts.filter((a) => a.correct === 1).length,
    },
  });
});
