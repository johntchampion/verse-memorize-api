/**
 * Tests for migrate() and its pre-rewrite guard.
 *
 * These drive the database directly rather than through the app, because the
 * thing under test is what happens to a file *before* the schema is applied.
 * Vitest gives each test file its own module graph, so the `:memory:` database
 * here is not shared with the integration tests.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { db, migrate } from '../src/db/client'

/** An empty database, as if the file had just been created. */
function emptyDatabase(): void {
  db.pragma('foreign_keys = OFF')
  for (const table of [
    'review_schedule',
    'attempt',
    'session_event',
    'session_exercise',
    'user_queue',
    'session_log',
    'user_verse',
    'users',
  ]) {
    db.exec(`DROP TABLE IF EXISTS ${table}`)
  }
  db.pragma('foreign_keys = ON')
}

/** The parts of the pre-rewrite schema the guard looks for. */
function createOldUserVerse(): void {
  db.exec(`
    CREATE TABLE user_verse (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      verse_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      strength INTEGER NOT NULL DEFAULT 0,
      correct_streak_in_tier INTEGER NOT NULL DEFAULT 0,
      slot INTEGER,
      activated_at TEXT NOT NULL,
      graduated_at TEXT
    )`)
}

function createReviewSchedule(): void {
  db.exec(`
    CREATE TABLE review_schedule (
      id TEXT PRIMARY KEY,
      user_verse_id TEXT NOT NULL,
      due_at TEXT NOT NULL,
      interval_days INTEGER NOT NULL
    )`)
}

function columnNames(table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((c) => c.name)
}

beforeEach(() => {
  emptyDatabase()
})

describe('migrate', () => {
  it('applies the schema to an empty database', () => {
    migrate()

    // The scheduling columns are the ones a stale file would be missing.
    expect(columnNames('user_verse')).toEqual(
      expect.arrayContaining([
        'due_at',
        'interval_days',
        'streak_date',
        'needs_relearning',
      ]),
    )
    expect(columnNames('users')).toContain('translation')
  })

  it('is safe to run on every boot', () => {
    migrate()
    expect(() => migrate()).not.toThrow()
  })

  it('backfills users.translation on a database that predates it', () => {
    migrate()
    db.exec('ALTER TABLE users DROP COLUMN translation')
    expect(columnNames('users')).not.toContain('translation')

    migrate()

    expect(columnNames('users')).toContain('translation')
  })

  it('creates session_event on a database that predates it', () => {
    migrate()
    db.exec('DROP TABLE session_event')

    migrate()

    expect(columnNames('session_event')).toEqual(
      expect.arrayContaining(['kind', 'session_date', 'stage_from', 'slot']),
    )
  })

  it('adds session_exercise.correct to a database that predates it', () => {
    migrate()
    db.exec('ALTER TABLE session_exercise DROP COLUMN correct')
    expect(columnNames('session_exercise')).not.toContain('correct')

    // CREATE TABLE IF NOT EXISTS cannot reshape a table that already exists,
    // which is the whole reason the column needs its own step.
    migrate()

    expect(columnNames('session_exercise')).toContain('correct')
  })
})

describe('the pre-rewrite guard', () => {
  it('refuses a database with a review_schedule table', () => {
    createReviewSchedule()

    expect(() => migrate()).toThrow(/review_schedule table/)
  })

  it('refuses a database with the old user_verse columns', () => {
    createOldUserVerse()

    expect(() => migrate()).toThrow(/user_verse\.strength column/)
  })

  it('names every marker it finds, not just the first', () => {
    createReviewSchedule()
    createOldUserVerse()

    let message = ''
    try {
      migrate()
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }

    expect(message).toContain('a review_schedule table')
    expect(message).toContain('a user_verse.strength column')
    expect(message).toContain('a user_verse.correct_streak_in_tier column')
  })

  it('says what to do about it', () => {
    createReviewSchedule()

    expect(() => migrate()).toThrow(/Move the file aside/)
  })

  it('rejects before touching the file', () => {
    createReviewSchedule()

    expect(() => migrate()).toThrow()

    // user_queue is new in the current schema. Its absence proves the guard ran
    // before db.exec(schema.sql), leaving the old file exactly as it was rather
    // than half-migrated.
    expect(columnNames('user_queue')).toEqual([])
  })

  it('lets a current-shape database through', () => {
    migrate()

    expect(() => migrate()).not.toThrow()
  })
})
