import { getVerse } from '../data/verses'
import { MAX_SLOTS } from '../models/Slots'
import { Streak } from '../models/Streak'
import { User } from '../models/User'
import * as sessionLogs from '../repositories/sessionLogRepository'
import * as users from '../repositories/userRepository'
import * as userVerses from '../repositories/userVerseRepository'

/** The GET /api/me body, shared with PATCH so both return one shape. */
export function profileView(userId: string) {
  const row = users.findById(userId)
  if (!row) return null

  const user = new User(row)
  const sessions = sessionLogs.allForUser(userId)
  const streak = new Streak(sessions, user.timezone)
  const today = user.today()

  return {
    user: {
      id: user.id,
      email: user.email,
      timezone: user.timezone,
      translation: user.translation,
      createdAt: user.createdAt,
      remindersEnabled: user.remindersEnabled,
    },
    streak: streak.lengthAsOf(today),
    completedToday: streak.completedOn(today),
    sessionsCompleted: sessions.length,
    versesStarted: userVerses.countForUser(userId),
    slots: {
      max: MAX_SLOTS,
      active: userVerses
        .slottedForUser(userId)
        .map((verse) => slotView(verse, user.translation, today)),
    },
  }
}

function slotView(
  verse: ReturnType<typeof userVerses.slottedForUser>[number],
  translation: string,
  today: string,
) {
  return {
    slot: verse.slot,
    userVerseId: verse.id,
    verseId: verse.verseId,
    reference: getVerse(verse.verseId, translation)?.reference ?? null,
    stage: verse.stage,
    consecutiveCorrect: verse.consecutiveCorrect,
    consecutiveIncorrect: verse.consecutiveIncorrect,
    // The correct-run only counts toward an upgrade if it was accrued today, so
    // the client needs the date to tell a live run from a dead one.
    streakDate: verse.streakDate,
    tierChangeUsedToday: verse.tierChangeUsedToday(today),
  }
}
