import type { Request } from 'express'
import { getVerse, versesInCanonOrder, versesInOrder } from '../data/verses'
import { NotFoundError } from '../lib/errors'
import { userId } from '../middleware/auth'
import { translation } from '../middleware/translation'
import { AttemptHistory } from '../models/AttemptHistory'
import { PracticeQueue } from '../models/PracticeQueue'
import * as attempts from '../repositories/attemptRepository'
import * as userVerses from '../repositories/userVerseRepository'
import { verseDetailView, verseListItem } from '../views/verseView'

const ATTEMPT_HISTORY_LIMIT = 100

export function index(req: Request) {
  const id = userId(req)
  const translationCode = translation(req)
  const progressByVerseId = userVerses.byVerseIdForUser(id)

  // `orderBy=canon` returns Bible order (Genesis through Revelation); anything
  // else, including omitted, keeps the curriculum order.
  const bank =
    req.query.orderBy === 'canon'
      ? versesInCanonOrder(translationCode)
      : versesInOrder(translationCode)

  return {
    translation: translationCode,
    verses: bank.map((verse) =>
      verseListItem(verse, progressByVerseId.get(verse.id)),
    ),
  }
}

export function show(req: Request<{ id: string }>) {
  const id = userId(req)
  const translationCode = translation(req)

  const verse = getVerse(req.params.id, translationCode)
  if (!verse) throw new NotFoundError('verse not found')

  const progress = userVerses.findByUserAndVerse(id, verse.id)

  return verseDetailView({
    verse,
    translation: translationCode,
    progress,
    history: new AttemptHistory(
      progress
        ? attempts.recentForUserVerse(progress.id, ATTEMPT_HISTORY_LIMIT)
        : [],
    ),
    queuePosition: new PracticeQueue(id).positionOf(verse.id),
  })
}
