import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { db, type UserRow } from '../db/client'
import { THEMES, themesForVerse } from '../data/themes'
import { versesInOrder } from '../data/verses'
import { translationFor } from '../lib/translation'
import { userId } from '../middleware/auth'
import {
  QueueError,
  hasCustomOrder,
  moveThemeToTop,
  moveVerseToFront,
  queueVerseIds,
  resetQueueOrder,
  rowsByVerseId,
  setQueueOrder,
} from '../services/queue'
import { SlotError, replaceSlot } from '../services/slotRefill'

export const queueRouter = Router()

function translationOf(req: Request, userId: string): string | undefined {
  const user = db
    .prepare('SELECT translation FROM users WHERE id = ?')
    .get(userId) as Pick<UserRow, 'translation'> | undefined
  return translationFor(req, user?.translation)
}

/**
 * The queue payload every route here responds with: the effective order with
 * per-verse state, plus the themes with how much of each is still queued.
 */
function queuePayload(userId: string, translation: string) {
  const rows = rowsByVerseId(userId)
  const byId = new Map(versesInOrder(translation).map((v) => [v.id, v]))
  const order = queueVerseIds(userId)
  const queued = new Set(order)

  return {
    translation,
    customized: hasCustomOrder(userId),
    queue: order.flatMap((verseId) => {
      const verse = byId.get(verseId)
      if (!verse) return []
      const row = rows.get(verseId)
      return [
        {
          id: verse.id,
          reference: verse.reference,
          order: verse.order,
          text: verse.text,
          // Carries saved progress (swapped out of a slot, or relearning) —
          // it re-enters practice where it left off.
          inProgress: row !== undefined,
          relearning: row?.needs_relearning === 1,
          stage: row?.stage ?? null,
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

/** Wraps a handler so queue/slot domain errors become 4xxs, not 500s. */
function handling(
  handler: (req: Request, res: Response) => void,
): (req: Request, res: Response) => void {
  return (req, res) => {
    try {
      handler(req, res)
    } catch (err) {
      if (err instanceof QueueError) {
        res.status(400).json({ error: err.message })
        return
      }
      if (err instanceof SlotError) {
        res.status(err.status).json({ error: err.message })
        return
      }
      throw err
    }
  }
}

/** The practice queue: what's coming next, in order. */
queueRouter.get('/queue', (req, res) => {
  const id = userId(req)
  const translation = translationOf(req, id)
  if (!translation) {
    res.status(400).json({ error: 'unknown translation' })
    return
  }
  res.json(queuePayload(id, translation))
})

const orderBody = z.object({ verseIds: z.array(z.string().min(1)).min(1) })

/** Stores a custom queue order. */
queueRouter.put(
  '/queue',
  handling((req, res) => {
    const id = userId(req)
    const translation = translationOf(req, id)
    if (!translation) {
      res.status(400).json({ error: 'unknown translation' })
      return
    }
    const parsed = orderBody.safeParse(req.body)
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'invalid body', details: z.treeifyError(parsed.error) })
      return
    }
    setQueueOrder(id, parsed.data.verseIds)
    res.json(queuePayload(id, translation))
  }),
)

/** Back to the default order. */
queueRouter.delete('/queue', (req, res) => {
  const id = userId(req)
  const translation = translationOf(req, id)
  if (!translation) {
    res.status(400).json({ error: 'unknown translation' })
    return
  }
  resetQueueOrder(id)
  res.json(queuePayload(id, translation))
})

const themeBody = z.object({ themeId: z.string().min(1) })

/**
 * Moves a whole theme to the front of the queue. The slots are left alone —
 * they keep what they're holding and refill from the new front of the queue
 * one at a time, as verses graduate or get swapped out.
 */
queueRouter.post(
  '/queue/theme',
  handling((req, res) => {
    const id = userId(req)
    const translation = translationOf(req, id)
    if (!translation) {
      res.status(400).json({ error: 'unknown translation' })
      return
    }
    const parsed = themeBody.safeParse(req.body)
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'invalid body', details: z.treeifyError(parsed.error) })
      return
    }
    moveThemeToTop(id, parsed.data.themeId)
    res.json(queuePayload(id, translation))
  }),
)

const nextBody = z.object({ verseId: z.string().min(1) })

/** Moves one verse to the front of the queue — the next-up spot. */
queueRouter.post(
  '/queue/next',
  handling((req, res) => {
    const id = userId(req)
    const translation = translationOf(req, id)
    if (!translation) {
      res.status(400).json({ error: 'unknown translation' })
      return
    }
    const parsed = nextBody.safeParse(req.body)
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'invalid body', details: z.treeifyError(parsed.error) })
      return
    }
    moveVerseToFront(id, parsed.data.verseId)
    res.json(queuePayload(id, translation))
  }),
)

const replaceBody = z.object({
  verseId: z.string().min(1),
  slot: z.number().int().min(1),
})

/**
 * Puts one verse straight into a chosen slot. The verse stepping aside keeps
 * its progress and rejoins the queue near the front.
 */
queueRouter.post(
  '/slots/replace',
  handling((req, res) => {
    const id = userId(req)
    const translation = translationOf(req, id)
    if (!translation) {
      res.status(400).json({ error: 'unknown translation' })
      return
    }
    const parsed = replaceBody.safeParse(req.body)
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'invalid body', details: z.treeifyError(parsed.error) })
      return
    }
    const { placed, displaced } = replaceSlot(
      id,
      parsed.data.verseId,
      parsed.data.slot,
    )
    // A displaced verse should come back soon: it takes the next-up spot
    // rather than sinking to wherever the default order would put it.
    if (displaced) moveVerseToFront(id, displaced.verse_id)
    res.json({ ...queuePayload(id, translation), placed, displaced })
  }),
)
