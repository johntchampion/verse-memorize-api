import { Router, type Request } from 'express'
import {
  db,
  type AttemptRow,
  type UserRow,
  type UserVerseRow,
} from '../db/client'
import { browseStatusFor } from '../domain/stage'
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

  const byVerseId = new Map(
    (
      db
        .prepare('SELECT * FROM user_verse WHERE user_id = ?')
        .all(id) as UserVerseRow[]
    ).map((row) => [row.verse_id, row]),
  )

  // `orderBy=canon` returns Bible order (Genesis through Revelation);
  // anything else (including omitted) keeps the curriculum order.
  const bank =
    req.query.orderBy === 'canon'
      ? versesInCanonOrder(translation)
      : versesInOrder(translation)

  const verses = bank.map((verse) => {
    const row = byVerseId.get(verse.id)
    return {
      id: verse.id,
      reference: verse.reference,
      order: verse.order,
      status: browseStatusFor(row?.stage),
      stage: row?.stage ?? null,
      // Pulled out of review and waiting for a slot — a flagged variant of
      // review rather than a browse status of its own.
      needsRelearning: row?.needs_relearning === 1,
      slot: row?.slot ?? null,
      // Graduation is an achievement the UI can badge, not a status of its own.
      graduatedAt: row?.graduated_at ?? null,
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

  const row = db
    .prepare('SELECT * FROM user_verse WHERE user_id = ? AND verse_id = ?')
    .get(id, verse.id) as UserVerseRow | undefined

  const attempts = row
    ? (db
        .prepare(
          'SELECT * FROM attempt WHERE user_verse_id = ? ORDER BY created_at DESC LIMIT 100',
        )
        .all(row.id) as AttemptRow[])
    : []

  // Scheduling lives on the row itself; a learning or queued verse has none.
  const schedule =
    row?.due_at != null
      ? { dueAt: row.due_at, intervalDays: row.interval_days }
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
    status: browseStatusFor(row?.stage),
    graduatedAt: row?.graduated_at ?? null,
    userVerse: row ?? null,
    schedule,
    history: {
      attempts,
      total: attempts.length,
      correct: attempts.filter((a) => a.correct === 1).length,
    },
  })
})
