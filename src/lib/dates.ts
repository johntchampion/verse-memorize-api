/**
 * Everything that reads a wall clock in a user's timezone.
 *
 * Most of the app deals in calendar days: `user_verse.due_at` and the
 * session-completion idempotency check are day concepts evaluated in the
 * user's timezone, never instants. The daily reminder is the exception — it
 * fires at a time of day — so the last two helpers convert between an instant
 * and a local time. They live here rather than in a module of their own
 * because they are the same Intl-over-IANA machinery as `todayInTimezone`,
 * including its fall-back-to-UTC behaviour for a timezone the platform
 * doesn't recognise.
 */

/** `YYYY-MM-DD` for "now" as seen in `timezone`. */
export function todayInTimezone(timezone: string, now = new Date()): string {
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now)
  } catch {
    // Unknown timezone on the user row — fall back to UTC rather than 500.
    return now.toISOString().slice(0, 10)
  }
}

/** Adds `days` to a `YYYY-MM-DD` string, returning the same format. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Minutes past local midnight for `instant` as seen in `timezone`, 0..1439.
 *
 * `hourCycle: 'h23'` rather than `hour12: false`: with the latter, several
 * locales render midnight as hour "24", which would come back as 1440 for the
 * one instant of the day where it matters most.
 */
export function minuteOfDayInTimezone(timezone: string, instant: Date): number {
  try {
    const parts = localParts(timezone, instant)
    return parts.hour * 60 + parts.minute
  } catch {
    // Unknown timezone on the user row — fall back to UTC, as todayInTimezone
    // does, rather than throwing out of a background job.
    return instant.getUTCHours() * 60 + instant.getUTCMinutes()
  }
}

interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/** `instant`'s wall-clock fields as read in `timezone`. Throws on a bad zone. */
function localParts(timezone: string, instant: Date): LocalParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant)

  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)!.value)

  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  }
}

/**
 * The UTC offset of `timezone` at `instant`, in milliseconds.
 *
 * Reads the instant's wall-clock fields in the zone and re-reads them as if
 * they were UTC; the gap between that and the real instant *is* the offset.
 * Intl exposes formatted fields and never a numeric offset, so this round trip
 * is the only way to get one out of the platform.
 */
function offsetMs(timezone: string, instant: Date): number {
  const p = localParts(timezone, instant)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - instant.getTime()
}

/**
 * The instant at which local `date` (YYYY-MM-DD) plus `minuteOfDay` occurs in
 * `timezone` — the inverse of todayInTimezone + minuteOfDayInTimezone.
 *
 * Two passes, because the offset needed is the one in force *at the answer*,
 * and the answer isn't known yet. The first treats the local fields as UTC and
 * subtracts the offset in force around then; the second re-reads the offset at
 * that candidate and corrects again if a DST transition fell between the two.
 * Two passes always suffice: no zone's offset changes twice within one shift.
 *
 * The degenerate cases are deliberate rather than accidental. A *nonexistent*
 * local time — the hour a spring-forward skips — has no instant to return, and
 * this lands on a stable one an hour off instead of throwing, so a reminder
 * fires an hour early once a year rather than not at all. An *ambiguous* one —
 * the hour a fall-back repeats — resolves to the first occurrence. Either way
 * the scheduler, which fires on `now >= due`, still sends exactly one reminder
 * that day.
 */
export function instantForLocalTime(
  timezone: string,
  date: string,
  minuteOfDay: number,
): Date {
  const [year, month, day] = date.split('-').map(Number)
  const asUtc = Date.UTC(
    year,
    month - 1,
    day,
    Math.floor(minuteOfDay / 60),
    minuteOfDay % 60,
  )

  try {
    const first = offsetMs(timezone, new Date(asUtc))
    const candidate = new Date(asUtc - first)
    const second = offsetMs(timezone, candidate)
    return second === first ? candidate : new Date(asUtc - second)
  } catch {
    return new Date(asUtc)
  }
}
