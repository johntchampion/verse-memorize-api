import { db } from './client'

export function tableExists(table: string): boolean {
  const found = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table)
  return found !== undefined
}

/** False for a column of a table that doesn't exist yet: PRAGMA table_info
    yields no rows for an unknown table rather than erroring. */
export function columnExists(table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string
  }[]
  return columns.some((c) => c.name === column)
}
