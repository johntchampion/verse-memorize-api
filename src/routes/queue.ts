import { Router } from 'express'
import { z } from 'zod'
import * as userVerses from '../repositories/userVerseRepository'
import { THEMES, themesForVerse } from '../data/themes'
import { versesInOrder } from '../data/verses'
import { validate, validated } from '../lib/http'
import { userId } from '../middleware/auth'
import { resolveTranslation, translation } from '../middleware/translation'
import { PracticeQueue } from '../models/PracticeQueue'
import { Slots } from '../models/Slots'

export const queueRouter = Router()

// Every route here serves verse text, so all of them need a resolved
// translation and all of them 400 on an unknown one.
queueRouter.use(resolveTranslation)

/**
 * The queue payload every route here responds with: the effective order with
 * per-verse state, plus the themes with how much of each is still queued.
 */
function queuePayload(userId: string, translationCode: string) {
  const queue = new PracticeQueue(userId)
  const progressByVerseId = userVerses.byVerseIdForUser(userId)
  const byId = new Map(versesInOrder(translationCode).map((v) => [v.id, v]))
  const order = queue.verseIds
  const queued = new Set(order)

  return {
    translation: translationCode,
    customized: queue.isCustomized,
    queue: order.flatMap((verseId) => {
      const verse = byId.get(verseId)
      if (!verse) return []
      const progress = progressByVerseId.get(verseId)
      return [
        {
          id: verse.id,
          reference: verse.reference,
          order: verse.order,
          text: verse.text,
          inProgress: PracticeQueue.hasSavedProgress(progress),
          relearning: progress?.needsRelearning ?? false,
          stage: progress?.stage ?? null,
          themeIds: themesForVerse(verse.id).map((t) => t.id),
        },
      ]
    }),
    themes: THEMES.map((theme) => ({
      id: theme.id,
      name: theme.name,
      total: theme.verseIds.length,
      queuedCount: theme.verseIds.filter((v) => queued.has(v)).length,
    })),
  }
}

/** The practice queue: what's coming next, in order. */
queueRouter.get('/queue', (req, res) => {
  res.json(queuePayload(userId(req), translation(req)))
})

const orderBody = z.object({ verseIds: z.array(z.string().min(1)).min(1) })

/** Stores a custom queue order. */
queueRouter.put('/queue', validate(orderBody), (req, res) => {
  const body = validated(req, orderBody)

  const id = userId(req)
  new PracticeQueue(id).setOrder(body.verseIds)
  res.json(queuePayload(id, translation(req)))
})

/** Back to the default order. */
queueRouter.delete('/queue', (req, res) => {
  const id = userId(req)
  new PracticeQueue(id).reset()
  res.json(queuePayload(id, translation(req)))
})

const themeBody = z.object({ themeId: z.string().min(1) })

/**
 * Moves a whole theme to the front of the queue. The slots are left alone —
 * they keep what they're holding and refill from the new front of the queue
 * one at a time, as verses graduate or get swapped out.
 */
queueRouter.post('/queue/theme', validate(themeBody), (req, res) => {
  const body = validated(req, themeBody)

  const id = userId(req)
  new PracticeQueue(id).moveThemeToTop(body.themeId)
  res.json(queuePayload(id, translation(req)))
})

const nextBody = z.object({ verseId: z.string().min(1) })

/** Moves one verse to the front of the queue — the next-up spot. */
queueRouter.post('/queue/next', validate(nextBody), (req, res) => {
  const body = validated(req, nextBody)

  const id = userId(req)
  new PracticeQueue(id).moveVerseToFront(body.verseId)
  res.json(queuePayload(id, translation(req)))
})

const replaceBody = z.object({
  verseId: z.string().min(1),
  slot: z.number().int().min(1),
})

/**
 * Puts one verse straight into a chosen slot. The verse stepping aside keeps
 * its progress and rejoins the queue near the front.
 */
queueRouter.post('/slots/replace', validate(replaceBody), (req, res) => {
  const body = validated(req, replaceBody)

  const id = userId(req)
  const { placed, displaced } = new Slots(id).replace(body.verseId, body.slot)

  // A displaced verse should come back soon: it takes the next-up spot rather
  // than sinking to wherever the default order would put it.
  if (displaced) new PracticeQueue(id).moveVerseToFront(displaced.verseId)

  res.json({
    ...queuePayload(id, translation(req)),
    placed: placed.toLegacyBody(),
    displaced: displaced ? displaced.toLegacyBody() : null,
  })
})
