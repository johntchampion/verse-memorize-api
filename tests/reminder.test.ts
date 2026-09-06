import { describe, expect, it } from 'vitest'
import {
  REMINDER_LATEST_MINUTE,
  reminderMinute,
  reminderVerdict,
  type ReminderInputs,
} from '../src/domain/reminder'

describe('reminderMinute', () => {
  it('defaults to 21:00 when there is no day to anchor to', () => {
    expect(reminderMinute(null)).toBe(REMINDER_LATEST_MINUTE)
    expect(reminderMinute(null)).toBe(21 * 60)
  })

  it.each([
    ['midnight', 0, 30],
    ['08:00 -> 08:30', 8 * 60, 8 * 60 + 30],
    ['20:29 -> 20:59, just under the cap', 20 * 60 + 29, 20 * 60 + 59],
    ['20:30 -> 21:00, exactly the cap', 20 * 60 + 30, 21 * 60],
  ])('offsets by 30 minutes: %s', (_label, anchor, expected) => {
    expect(reminderMinute(anchor)).toBe(expected)
  })

  it.each([
    ['20:45 would be 21:15', 20 * 60 + 45],
    ['21:30 is already past it', 21 * 60 + 30],
    ['23:50 would wrap past midnight', 23 * 60 + 50],
  ])('caps at 21:00: %s', (_label, anchor) => {
    expect(reminderMinute(anchor)).toBe(REMINDER_LATEST_MINUTE)
  })

  it('never returns a minute outside the day', () => {
    for (let anchor = 0; anchor < 24 * 60; anchor += 1) {
      const minute = reminderMinute(anchor)
      expect(minute).toBeGreaterThanOrEqual(0)
      expect(minute).toBeLessThan(24 * 60)
    }
  })
})

const HOUR = 60 * 60 * 1000

/** Due an hour ago, nothing suppressing it: the 'send' baseline. */
function inputs(overrides: Partial<ReminderInputs> = {}): ReminderInputs {
  return {
    nowMs: 1_000 * HOUR,
    dueMs: 999 * HOUR,
    catchUpMs: 2 * HOUR,
    completedToday: false,
    lastAttemptMs: null,
    midSessionMs: 30 * 60 * 1000,
    ...overrides,
  }
}

describe('reminderVerdict', () => {
  it('sends once due with nothing suppressing it', () => {
    expect(reminderVerdict(inputs())).toBe('send')
  })

  it('sends on the due minute itself, not only after it', () => {
    expect(reminderVerdict(inputs({ nowMs: 999 * HOUR }))).toBe('send')
  })

  it('waits while the due time is still ahead', () => {
    expect(reminderVerdict(inputs({ nowMs: 998 * HOUR }))).toBe('not-yet')
  })

  it('gives up once the catch-up window has passed', () => {
    expect(reminderVerdict(inputs({ nowMs: 1_002 * HOUR }))).toBe('too-late')
  })

  it('still sends at the very edge of the catch-up window', () => {
    expect(reminderVerdict(inputs({ nowMs: 1_001 * HOUR }))).toBe('send')
  })

  it('skips a session already completed today', () => {
    expect(reminderVerdict(inputs({ completedToday: true }))).toBe('completed')
  })

  it('skips someone who is practising right now', () => {
    const nowMs = 1_000 * HOUR
    expect(
      reminderVerdict(inputs({ nowMs, lastAttemptMs: nowMs - 10 * 60 * 1000 })),
    ).toBe('mid-session')
  })

  it('does not treat an attempt older than the window as mid-session', () => {
    const nowMs = 1_000 * HOUR
    expect(
      reminderVerdict(inputs({ nowMs, lastAttemptMs: nowMs - 45 * 60 * 1000 })),
    ).toBe('send')
  })

  // The cheap checks come first on purpose: the scheduler relies on that
  // ordering to skip the session_log and attempt queries on every tick where
  // the answer is simply 'not-yet'.
  it('reports not-yet ahead of the checks that need queries', () => {
    expect(
      reminderVerdict(
        inputs({ nowMs: 998 * HOUR, completedToday: true, lastAttemptMs: 0 }),
      ),
    ).toBe('not-yet')
  })

  it('reports too-late ahead of the checks that need queries', () => {
    expect(
      reminderVerdict(inputs({ nowMs: 1_002 * HOUR, completedToday: true })),
    ).toBe('too-late')
  })
})
