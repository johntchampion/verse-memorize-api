import { describe, expect, it } from 'vitest'
import {
  addDays,
  instantForLocalTime,
  minuteOfDayInTimezone,
  todayInTimezone,
} from '../src/lib/dates'

describe('todayInTimezone', () => {
  it('reads the local date, not the UTC one', () => {
    // 05:30Z on the 1st is still 23:30 on the previous day in Chicago.
    expect(
      todayInTimezone('America/Chicago', new Date('2026-01-01T05:30:00Z')),
    ).toBe('2025-12-31')
  })

  it('falls back to UTC for a timezone the platform doesn’t know', () => {
    expect(
      todayInTimezone('Mars/Olympus', new Date('2026-01-01T05:30:00Z')),
    ).toBe('2026-01-01')
  })
})

describe('addDays', () => {
  it('crosses a month boundary', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })
})

describe('minuteOfDayInTimezone', () => {
  it('returns 0 at local midnight rather than 1440', () => {
    // The hourCycle: 'h23' guard. With hour12: false some locales render
    // midnight as hour "24", which would come back as 1440.
    expect(minuteOfDayInTimezone('UTC', new Date('2026-01-01T00:00:00Z'))).toBe(
      0,
    )
    expect(
      minuteOfDayInTimezone(
        'America/Chicago',
        new Date('2026-01-01T06:00:00Z'),
      ),
    ).toBe(0)
  })

  it('reads the local wall clock, not the UTC one', () => {
    expect(
      minuteOfDayInTimezone(
        'America/Chicago',
        new Date('2026-01-01T05:30:00Z'),
      ),
    ).toBe(23 * 60 + 30)
  })

  it('handles a zone offset by a fraction of an hour', () => {
    // Asia/Kolkata is +05:30 year round.
    expect(
      minuteOfDayInTimezone('Asia/Kolkata', new Date('2026-01-01T00:00:00Z')),
    ).toBe(5 * 60 + 30)
  })

  it('falls back to UTC for a timezone the platform doesn’t know', () => {
    expect(
      minuteOfDayInTimezone('Mars/Olympus', new Date('2026-01-01T07:45:00Z')),
    ).toBe(7 * 60 + 45)
  })
})

describe('instantForLocalTime', () => {
  it('is the inverse of minuteOfDayInTimezone across offsets and seasons', () => {
    const zones = [
      'UTC',
      'America/Chicago',
      'America/Los_Angeles',
      'Pacific/Auckland',
      // +05:30 and +12:45 catch offset arithmetic that assumed whole hours.
      'Asia/Kolkata',
      'Pacific/Chatham',
    ]
    const dates = ['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15']
    const minutes = [0, 1, 7 * 60 + 45, 12 * 60, 21 * 60, 23 * 60 + 59]

    for (const zone of zones) {
      for (const date of dates) {
        for (const minute of minutes) {
          const instant = instantForLocalTime(zone, date, minute)
          expect([
            zone,
            date,
            minute,
            minuteOfDayInTimezone(zone, instant),
          ]).toEqual([zone, date, minute, minute])
          expect([zone, date, minute, todayInTimezone(zone, instant)]).toEqual([
            zone,
            date,
            minute,
            date,
          ])
        }
      }
    }
  })

  it('resolves a plain local time in a fixed-offset zone', () => {
    expect(
      instantForLocalTime('Asia/Kolkata', '2026-01-15', 9 * 60).toISOString(),
    ).toBe('2026-01-15T03:30:00.000Z')
  })

  // America/Chicago springs forward at 02:00 local on 2026-03-08: 01:59:59 CST
  // is followed by 03:00:00 CDT, and 02:00–02:59 never happens.
  describe('spring forward (America/Chicago, 2026-03-08)', () => {
    it('resolves the hour before the shift at the pre-shift offset', () => {
      expect(
        instantForLocalTime('America/Chicago', '2026-03-08', 60).toISOString(),
      ).toBe('2026-03-08T07:00:00.000Z')
    })

    it('resolves the hour after the shift at the post-shift offset', () => {
      expect(
        instantForLocalTime(
          'America/Chicago',
          '2026-03-08',
          3 * 60,
        ).toISOString(),
      ).toBe('2026-03-08T08:00:00.000Z')
    })

    // 02:30 local does not exist. There is no right answer, so what matters is
    // that there is a stable one — not a throw and not an Invalid Date. This
    // pins the documented behavior so a refactor can't quietly change it.
    it('lands a nonexistent local time on a stable instant', () => {
      const instant = instantForLocalTime(
        'America/Chicago',
        '2026-03-08',
        2 * 60 + 30,
      )
      expect(instant.getTime()).not.toBeNaN()
      // Lands an hour earlier, at 01:30 CST — the last local time before the
      // gap opens.
      expect(instant.toISOString()).toBe('2026-03-08T07:30:00.000Z')
      expect(minuteOfDayInTimezone('America/Chicago', instant)).toBe(90)
      // Still the right day, which is all the scheduler needs.
      expect(todayInTimezone('America/Chicago', instant)).toBe('2026-03-08')
    })
  })

  // America/Chicago falls back at 02:00 local on 2026-11-01: 01:00–01:59
  // happens twice, once at -05:00 (CDT) and again at -06:00 (CST).
  describe('fall back (America/Chicago, 2026-11-01)', () => {
    it('resolves an ambiguous local time to the first occurrence', () => {
      expect(
        instantForLocalTime(
          'America/Chicago',
          '2026-11-01',
          60 + 30,
        ).toISOString(),
      ).toBe('2026-11-01T06:30:00.000Z')
    })

    it('resolves an unambiguous time later the same day', () => {
      expect(
        instantForLocalTime(
          'America/Chicago',
          '2026-11-01',
          21 * 60,
        ).toISOString(),
      ).toBe('2026-11-02T03:00:00.000Z')
    })
  })

  // The southern hemisphere shifts the other way at the other end of the year,
  // so this exercises the sign of the correction in both directions.
  describe('southern hemisphere (Australia/Sydney, 2026-10-04)', () => {
    it('resolves the hour before the spring-forward shift', () => {
      // 01:00 AEST (+10:00), before the 02:00 jump to AEDT.
      expect(
        instantForLocalTime('Australia/Sydney', '2026-10-04', 60).toISOString(),
      ).toBe('2026-10-03T15:00:00.000Z')
    })

    it('resolves the hour after the spring-forward shift', () => {
      expect(
        instantForLocalTime(
          'Australia/Sydney',
          '2026-10-04',
          3 * 60,
        ).toISOString(),
      ).toBe('2026-10-03T16:00:00.000Z')
    })
  })

  it('falls back to UTC for a timezone the platform doesn’t know', () => {
    expect(
      instantForLocalTime('Mars/Olympus', '2026-01-15', 9 * 60).toISOString(),
    ).toBe('2026-01-15T09:00:00.000Z')
  })
})
