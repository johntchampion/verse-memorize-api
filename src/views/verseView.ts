import type { Verse } from '../data/verses'
import { themesForVerse } from '../data/themes'
import { browseStatusFor } from '../domain/stage'
import type { AttemptHistory } from '../models/AttemptHistory'
import type { UserVerse } from '../models/UserVerse'

/** One row of GET /api/verses. */
export function verseListItem(verse: Verse, progress: UserVerse | undefined) {
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
}

export interface VerseDetailInput {
  verse: Verse
  translation: string
  progress: UserVerse | undefined
  history: AttemptHistory
  queuePosition: number | null
}

export function verseDetailView({
  verse,
  translation,
  progress,
  history,
  queuePosition,
}: VerseDetailInput) {
  return {
    translation,
    verse: {
      id: verse.id,
      reference: verse.reference,
      order: verse.order,
      text: verse.text,
    },
    themes: themesForVerse(verse.id).map((theme) => ({
      id: theme.id,
      name: theme.name,
    })),
    queuePosition,
    status: browseStatusFor(progress?.stage),
    graduatedAt: progress?.graduatedAt ?? null,
    userVerse: progress ? progress.toLegacyBody() : null,
    // Only review and mastered are scheduled; a learning or queued verse has no
    // due date at all, which is what a null schedule means.
    schedule:
      progress?.dueAt != null
        ? { dueAt: progress.dueAt, intervalDays: progress.intervalDays }
        : null,
    history: history.toBody(),
  }
}
