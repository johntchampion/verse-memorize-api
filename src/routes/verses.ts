import { Router, type Request } from 'express'
import { db, type AttemptRow, type UserRow } from '../db/client'
import * as userVerses from '../db/userVerseRepository'
import { browseStatusFor } from '../domain/stage'
import { legacyUserVerseBody } from '../domain/userVerse'
import { themesForVerse } from '../data/themes'
import { getVerse, versesInCanonOrder, versesInOrder } from '../data/verses'
import { translationFor } from '../lib/translation'
import { userId } from '../middleware/auth'
import { queueVerseIds } from '../services/queue'

export const versesRouter = Router()

/**
 * The translation to serve this request in — the account preference unless
 * `?translation=` overrides it. Returns undefined for an unknown code so the
 * handler can 400 rather than silently serving something else.
 */
function translationOf(req: Request, id: string): string | undefined {
  const user = db
    .prepare('SELECT translation FROM users WHERE id = ?')
    .get(id) as Pick<UserRow, 'translation'> | undefined
  return translationFor(req, user?.translation)
}

/** The full bank with per-user status. */
versesRouter.get('/verses', (req, res) => {
  const id = userId(req)
  const translation = translationOf(req, id)
  if (!translation) {
    res.status(400).json({ error: 'unknown translation' })
    return
  }

  const progressByVerseId = userVerses.byVerseIdForUser(id)

  // `orderBy=canon` returns Bible order (Genesis through Revelation);
  // anything else (including omitted) keeps the curriculum order.
  const bank =
    req.query.orderBy === 'canon'
      ? versesInCanonOrder(translation)
      : versesInOrder(translation)

  const verses = bank.map((verse) => {
    const progress = progressByVerseId.get(verse.id)
    return {
      id: verse.id,
      reference: verse.reference,
      order: verse.order,
      status: browseStatusFor(progress?.stage),
      stage: progress?.stage ?? null,
      // Pulled out of review and waiting for a slot — a flagged variant of
      // review rather than a browse status of its own.
      needsRelearning: progress?.needsRelearning ?? false,
      slot: progress?.slot ?? null,
      // Graduation is an achievement the UI can badge, not a status of its own.
      graduatedAt: progress?.graduatedAt ?? null,
      text: verse.text,
    }
  })

  res.json({ translation, verses })
})

/** Single verse detail plus this user's history. */
versesRouter.get('/verses/:id', (req, res) => {
  const id = userId(req)
  const translation = translationOf(req, id)
  if (!translation) {
    res.status(400).json({ error: 'unknown translation' })
    return
  }

  const verse = getVerse(req.params.id, translation)
  if (!verse) {
    res.status(404).json({ error: 'verse not found' })
    return
  }

  const progress = userVerses.findByUserAndVerse(id, verse.id)

  const attempts = progress
    ? (db
        .prepare(
          'SELECT * FROM attempt WHERE user_verse_id = ? ORDER BY created_at DESC LIMIT 100',
        )
        .all(progress.id) as AttemptRow[])
    : []

  // Scheduling lives on the row itself; a learning or queued verse has none.
  const schedule =
    progress?.dueAt != null
      ? { dueAt: progress.dueAt, intervalDays: progress.intervalDays }
      : null

  // Where this verse sits in the practice queue (1 = next up), or null when
  // it isn't queued — slotted or memorized.
  const queueIndex = queueVerseIds(id).indexOf(verse.id)

  res.json({
    translation,
    verse: {
      id: verse.id,
      reference: verse.reference,
      order: verse.order,
      text: verse.text,
    },
    themes: themesForVerse(verse.id).map((t) => ({ id: t.id, name: t.name })),
    queuePosition: queueIndex === -1 ? null : queueIndex + 1,
    status: browseStatusFor(progress?.stage),
    graduatedAt: progress?.graduatedAt ?? null,
    userVerse: progress ? legacyUserVerseBody(progress) : null,
    schedule,
    history: {
      attempts,
      total: attempts.length,
      correct: attempts.filter((a) => a.correct === 1).length,
    },
  })
})
