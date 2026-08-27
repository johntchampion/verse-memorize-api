import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type Stage =
  | 'learning_light'
  | 'learning_medium'
  | 'learning_heavy'
  | 'review'
  | 'mastered'
  | 'decayed';

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
  strength: number;
  correct_streak_in_tier: number;
  slot: number | null;
  activated_at: string;
  graduated_at: string | null;
}

export interface ReviewScheduleRow {
  id: string;
  user_verse_id: string;
  due_at: string;
  interval_days: number;
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

/**
 * Applies schema.sql. Every statement is IF NOT EXISTS, so this is safe to run
 * on every boot — there is no migration tooling in v1.
 */
export function migrate(): void {
  // Resolved relative to this module so it works from both src/ (tsx) and
  // dist/ (compiled); the build script copies schema.sql alongside.
  const schemaPath = path.join(__dirname, 'schema.sql');
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
}
