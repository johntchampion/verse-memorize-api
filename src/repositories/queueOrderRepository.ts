import { db } from '../db/client'

/**
 * A user's custom queue order, stored as a JSON array of verse ids. No row
 * means the default order.
 */
export function read(userId: string): string[] | null {
  const row = db
    .prepare('SELECT verse_order FROM user_queue WHERE user_id = ?')
    .get(userId) as { verse_order: string } | undefined
  if (!row) return null

  try {
    const parsed: unknown = JSON.parse(row.verse_order)
    return Array.isArray(parsed)
      ? parsed.filter((id) => typeof id === 'string')
      : null
  } catch {
    return null
  }
}

export function write(userId: string, verseIds: string[], now: string): void {
  db.prepare(
    `INSERT INTO user_queue (user_id, verse_order, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE
       SET verse_order = excluded.verse_order, updated_at = excluded.updated_at`,
  ).run(userId, JSON.stringify(verseIds), now)
}

export function remove(userId: string): void {
  db.prepare('DELETE FROM user_queue WHERE user_id = ?').run(userId)
}
