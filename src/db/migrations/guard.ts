import { columnExists, tableExists } from '../introspect'

/** Each is reported rather than just the first, so a partially hand-edited
    file names everything still wrong with it. */
function preRewriteMarkers(): string[] {
  const markers: string[] = []
  if (tableExists('review_schedule')) markers.push('a review_schedule table')
  for (const column of ['strength', 'correct_streak_in_tier']) {
    if (columnExists('user_verse', column)) {
      markers.push(`a user_verse.${column} column`)
    }
  }
  return markers
}

/**
 * `CREATE TABLE IF NOT EXISTS` will not reshape the old `user_verse`, so the
 * scheduling columns would never exist and every read would come back missing
 * them. Failing here names the cause; failing later names only a symptom.
 * There is no upgrade path — a 0-100 strength score cannot be turned into
 * streak counters and an interval ladder.
 */
export function rejectPreRewriteDatabase(dbPath: string): void {
  const markers = preRewriteMarkers()
  if (markers.length === 0) return

  throw new Error(
    `${dbPath} was written by the pre-rewrite progression model (found ${markers.join(', ')}).\n` +
      'The current schema cannot reshape it, and the old strength score cannot ' +
      'be converted into the streak counters and interval ladder that replaced ' +
      'it. Move the file aside and let a fresh one be created.',
  )
}
