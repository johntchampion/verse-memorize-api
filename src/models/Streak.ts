import type { SessionLogRow } from '../db/rows'
import { addDays, todayInTimezone } from '../lib/dates'

/** completed_at is a UTC instant, so every question about days goes through the
    user's timezone first — this is the one place that conversion happens. */
export class Streak {
  private readonly days: Set<string>

  constructor(sessions: SessionLogRow[], timezone: string) {
    this.days = new Set(
      sessions.map((row) =>
        todayInTimezone(timezone, new Date(row.completed_at)),
      ),
    )
  }

  completedOn(date: string): boolean {
    return this.days.has(date)
  }

  /** Consecutive days ending on `today`, or on yesterday if today isn't done yet. */
  lengthAsOf(today: string): number {
    // An unfinished today shouldn't zero out a streak that's still alive.
    let cursor = this.days.has(today) ? today : addDays(today, -1)

    let length = 0
    while (this.days.has(cursor)) {
      length += 1
      cursor = addDays(cursor, -1)
    }
    return length
  }
}
