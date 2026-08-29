import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type Stage =
  | 'learning_light'
  | 'learning_medium'
  | 'learning_heavy'
  | 'review'
  | 'mastered';

export type ExerciseType = 'tile_fill_blank' | 'type_fill_blank';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
  timezone: string;
}

export interface UserVerseRow {
  id: string;
  user_id: string;
  verse_id: string;
  stage: Stage;
  consecutive_correct: number;
  consecutive_incorrect: number;
  streak_date: string | null;
  interval_days: number | null;
  due_at: string | null;
  last_upgrade_date: string | null;
  last_downgrade_date: string | null;
  needs_relearning: number;
  relearning_queued_at: string | null;
  slot: number | null;
  activated_at: string;
  graduated_at: string | null;
}

export interface AttemptRow {
  id: string;
  user_verse_id: string;
  exercise_type: ExerciseType;
  correct: number;
  created_at: string;
}

export interface SessionLogRow {
  id: string;
  user_id: string;
  completed_at: string;
}

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), 'data.sqlite');

export const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/** True when the file predates the progression rewrite. */
function hasLegacySchema(): boolean {
  const legacy = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_schedule'")
    .get();
  if (legacy) return true;

  const columns = db.prepare('PRAGMA table_info(user_verse)').all() as { name: string }[];
  return columns.some((c) => c.name === 'strength');
}

/**
 * Applies schema.sql. Every statement is IF NOT EXISTS, so this is safe to run
 * on every boot — there is no migration tooling in v1.
 *
 * That also means it cannot reshape a table that already exists, so a database
 * written before the progression rewrite is rejected outright rather than left
 * to fail confusingly at query time.
 */
export function migrate(): void {
  if (hasLegacySchema()) {
    throw new Error(
      `${DB_PATH} uses the pre-rewrite schema, which cannot be migrated in place. ` +
        'Delete it (along with its -wal and -shm files) and restart to recreate it.',
    );
  }

  // Resolved relative to this module so it works from both src/ (tsx) and
  // dist/ (compiled); the build script copies schema.sql alongside.
  const schemaPath = path.join(__dirname, 'schema.sql');
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
}
