/**
 * End-to-end proof that ON DELETE CASCADE (added in src/db/schema.sql plus
 * the rebuild migration in src/db/client.ts) actually removes dependent rows.
 * Drives `db` directly, like migrate.test.ts, since the guarantee under test
 * is a database-level one, not an HTTP behavior.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '../src/db/client'
import { initDb, resetDb } from './helpers'

beforeAll(() => {
  initDb()
})

beforeEach(() => {
  resetDb()
})

function seedFullUser(userId: string, verseId: string): void {
  db.prepare(
    `INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'h', '2024-01-01T00:00:00Z')`,
  ).run(userId, `${userId}@example.com`)
  db.prepare(
    `INSERT INTO user_verse (id, user_id, verse_id, stage, activated_at)
     VALUES (?, ?, 'john-3-16', 'learning_light', '2024-01-01T00:00:00Z')`,
  ).run(verseId, userId)
  db.prepare(
    `INSERT INTO user_queue (user_id, verse_order, updated_at) VALUES (?, '[]', '2024-01-01T00:00:00Z')`,
  ).run(userId)
  db.prepare(
    `INSERT INTO session_log (id, user_id, completed_at) VALUES (?, ?, '2024-01-01T00:00:00Z')`,
  ).run(`sl-${userId}`, userId)
  db.prepare(
    `INSERT INTO session_exercise (id, user_id, session_date, position, user_verse_id, queue, instance)
     VALUES (?, ?, '2024-01-01', 0, ?, 'learning', 0)`,
  ).run(`se-${userId}`, userId, verseId)
  db.prepare(
    `INSERT INTO session_event (id, user_id, session_date, created_at, kind, user_verse_id, verse_id)
     VALUES (?, ?, '2024-01-01', '2024-01-01T00:00:00Z', 'stage_change', ?, 'john-3-16')`,
  ).run(`sev-${userId}`, userId, verseId)
  db.prepare(
    `INSERT INTO attempt (id, user_verse_id, exercise_type, correct, created_at)
     VALUES (?, ?, 'tile_fill_blank', 1, '2024-01-01T00:00:00Z')`,
  ).run(`a-${userId}`, verseId)
}

describe('ON DELETE CASCADE', () => {
  it('deleting a user removes every dependent row, including attempt via user_verse', () => {
    seedFullUser('u1', 'uv1')

    db.prepare('DELETE FROM users WHERE id = ?').run('u1')

    expect(
      db.prepare('SELECT 1 FROM user_verse WHERE user_id = ?').get('u1'),
    ).toBeUndefined()
    expect(
      db.prepare('SELECT 1 FROM user_queue WHERE user_id = ?').get('u1'),
    ).toBeUndefined()
    expect(
      db.prepare('SELECT 1 FROM session_log WHERE user_id = ?').get('u1'),
    ).toBeUndefined()
    expect(
      db.prepare('SELECT 1 FROM session_exercise WHERE user_id = ?').get('u1'),
    ).toBeUndefined()
    expect(
      db.prepare('SELECT 1 FROM session_event WHERE user_id = ?').get('u1'),
    ).toBeUndefined()
    // attempt has no user_id column; this proves the cascade from users into
    // user_verse propagates a second time, from the deleted user_verse row
    // into attempt.
    expect(
      db.prepare('SELECT 1 FROM attempt WHERE user_verse_id = ?').get('uv1'),
    ).toBeUndefined()
  })

  it('deleting a user_verse row removes its attempt, session_exercise, and session_event rows but leaves the user', () => {
    seedFullUser('u2', 'uv2')

    db.prepare('DELETE FROM user_verse WHERE id = ?').run('uv2')

    expect(
      db.prepare('SELECT 1 FROM users WHERE id = ?').get('u2'),
    ).toBeDefined()
    expect(
      db.prepare('SELECT 1 FROM attempt WHERE user_verse_id = ?').get('uv2'),
    ).toBeUndefined()
    expect(
      db
        .prepare('SELECT 1 FROM session_exercise WHERE user_verse_id = ?')
        .get('uv2'),
    ).toBeUndefined()
    expect(
      db
        .prepare('SELECT 1 FROM session_event WHERE user_verse_id = ?')
        .get('uv2'),
    ).toBeUndefined()
  })
})
