import type { Request } from 'express'
import { userId } from '../middleware/auth'
import { translation } from '../middleware/translation'
import { PracticeQueue } from '../models/PracticeQueue'
import { Slots } from '../models/Slots'
import type {
  NextVerseInput,
  QueueOrderInput,
  SlotReplaceInput,
  ThemeInput,
} from '../schemas'
import { queueView } from '../views/queueView'

function view(req: Request) {
  return queueView(userId(req), translation(req))
}

export function show(req: Request) {
  return view(req)
}

export function replaceOrder(req: Request, body: QueueOrderInput) {
  new PracticeQueue(userId(req)).setOrder(body.verseIds)
  return view(req)
}

export function resetOrder(req: Request) {
  new PracticeQueue(userId(req)).reset()
  return view(req)
}

/**
 * The slots are left alone — they keep what they're holding and refill from the
 * new front of the queue one at a time, as verses graduate or get swapped out.
 */
export function moveTheme(req: Request, body: ThemeInput) {
  new PracticeQueue(userId(req)).moveThemeToTop(body.themeId)
  return view(req)
}

export function moveNext(req: Request, body: NextVerseInput) {
  new PracticeQueue(userId(req)).moveVerseToFront(body.verseId)
  return view(req)
}

/** The verse stepping aside keeps its progress and rejoins the queue near the front. */
export function replaceSlot(req: Request, body: SlotReplaceInput) {
  const id = userId(req)
  const { placed, displaced } = new Slots(id).replace(body.verseId, body.slot)

  // A displaced verse should come back soon: it takes the next-up spot rather
  // than sinking to wherever the default order would put it.
  if (displaced) new PracticeQueue(id).moveVerseToFront(displaced.verseId)

  return {
    ...view(req),
    placed: placed.toLegacyBody(),
    displaced: displaced ? displaced.toLegacyBody() : null,
  }
}
