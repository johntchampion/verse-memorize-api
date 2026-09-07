import { THEMES, themesForVerse } from '../data/themes'
import { versesInOrder } from '../data/verses'
import { PracticeQueue } from '../models/PracticeQueue'
import * as userVerses from '../repositories/userVerseRepository'

/**
 * The queue every /api/queue route responds with: the effective order with
 * per-verse state, plus the themes and how much of each is still queued.
 */
export function queueView(userId: string, translation: string) {
  const queue = new PracticeQueue(userId)
  const progressByVerseId = userVerses.byVerseIdForUser(userId)
  const bank = new Map(versesInOrder(translation).map((v) => [v.id, v]))
  const order = queue.verseIds
  const queued = new Set(order)

  return {
    translation,
    customized: queue.isCustomized,
    queue: order.flatMap((verseId) => {
      const verse = bank.get(verseId)
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
          themeIds: themesForVerse(verse.id).map((theme) => theme.id),
        },
      ]
    }),
    themes: THEMES.map((theme) => ({
      id: theme.id,
      name: theme.name,
      total: theme.verseIds.length,
      queuedCount: theme.verseIds.filter((id) => queued.has(id)).length,
    })),
  }
}
