import { Router } from 'express'
import * as attempts from '../repositories/attemptRepository'
import * as userVerses from '../repositories/userVerseRepository'
import { browseStatusFor } from '../domain/stage'
import { NotFoundError } from '../lib/errors'
import { legacyUserVerseBody } from '../domain/userVerse'
import { themesForVerse } from '../data/themes'
import { getVerse, versesInCanonOrder, versesInOrder } from '../data/verses'
import { userId } from '../middleware/auth'
import { resolveTranslation, translation } from '../middleware/translation'
import { queueVerseIds } from '../services/queue'

const ATTEMPT_HISTORY_LIMIT = 100

export const versesRouter = Router()

// Both routes serve verse text, so both need a resolved translation.
versesRouter.use(resolveTranslation)

/** The full bank with per-user status. */
versesRouter.get('/verses', (req, res) => {
  const id = userId(req)
  const translationCode = translation(req)
  const progressByVerseId = userVerses.byVerseIdForUser(id)

  // `orderBy=canon` returns Bible order (Genesis through Revelation);
  // anything else (including omitted) keeps the curriculum order.
  const bank =
    req.query.orderBy === 'canon'
      ? versesInCanonOrder(translationCode)
      : versesInOrder(translationCode)

  const listed = bank.map((verse) => {
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

  res.json({ translation: translationCode, verses: listed })
})

/** Single verse detail plus this user's history. */
versesRouter.get('/verses/:id', (req, res) => {
  const id = userId(req)
  const translationCode = translation(req)

  const verse = getVerse(req.params.id, translationCode)
  if (!verse) throw new NotFoundError('verse not found')

  const progress = userVerses.findByUserAndVerse(id, verse.id)

  const history = progress
    ? attempts.recentForUserVerse(progress.id, ATTEMPT_HISTORY_LIMIT)
    : []

  // Only review and mastered are scheduled; a learning or queued verse has no
  // due date at all, which is what a null schedule means here.
  const schedule =
    progress?.dueAt != null
      ? { dueAt: progress.dueAt, intervalDays: progress.intervalDays }
      : null

  // Where this verse sits in the practice queue (1 = next up), or null when
  // it isn't queued — slotted or memorized.
  const queueIndex = queueVerseIds(id).indexOf(verse.id)

  res.json({
    translation: translationCode,
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
      attempts: history,
      total: history.length,
      correct: history.filter((a) => a.correct === 1).length,
    },
  })
})
