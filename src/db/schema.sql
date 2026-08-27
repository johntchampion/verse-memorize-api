-- Per-user state only. Verse text and decoys live in src/data/verses.ts and
-- are never written to the database.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,           -- uuid
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,      -- ISO 8601
  timezone TEXT NOT NULL DEFAULT 'UTC'  -- for "day" boundary calculations
);

CREATE TABLE IF NOT EXISTS user_verse (
  id TEXT PRIMARY KEY,           -- uuid
  user_id TEXT NOT NULL REFERENCES users(id),
  verse_id TEXT NOT NULL,        -- references data/verses.ts id, not a DB fk
  stage TEXT NOT NULL,           -- 'learning_light' | 'learning_medium' |
                                 -- 'learning_heavy' | 'review' | 'mastered'
                                 -- | 'decayed'. Graduation is an event stamped
                                 -- in graduated_at, not a stage.
  strength INTEGER NOT NULL DEFAULT 0,   -- 0-100
  correct_streak_in_tier INTEGER NOT NULL DEFAULT 0,
  slot INTEGER,                  -- 1, 2, or 3 while in an active learning
                                 -- slot; NULL once graduated
  activated_at TEXT NOT NULL,
  graduated_at TEXT,
  UNIQUE(user_id, verse_id)
);

CREATE TABLE IF NOT EXISTS review_schedule (
  id TEXT PRIMARY KEY,
  user_verse_id TEXT NOT NULL REFERENCES user_verse(id),
  due_at TEXT NOT NULL,          -- ISO date, date-only (no time component)
  interval_days INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attempt (
  id TEXT PRIMARY KEY,
  user_verse_id TEXT NOT NULL REFERENCES user_verse(id),
  exercise_type TEXT NOT NULL,   -- 'tile_fill_blank' | 'type_fill_blank'
  correct INTEGER NOT NULL,      -- 0 or 1
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  completed_at TEXT NOT NULL     -- one row per completed daily session;
                                 -- this drives slot ramp-up, not calendar days
);

-- Access-path indexes. Each one backs a lookup the app actually makes: session
-- build reads user_verse by user, the review queue joins review_schedule by
-- user_verse, verse detail reads attempt history, and the ramp-up check counts
-- session_log by user.
CREATE INDEX IF NOT EXISTS idx_user_verse_user ON user_verse(user_id);
CREATE INDEX IF NOT EXISTS idx_review_schedule_uv ON review_schedule(user_verse_id);
CREATE INDEX IF NOT EXISTS idx_attempt_uv ON attempt(user_verse_id, created_at);
CREATE INDEX IF NOT EXISTS idx_session_log_user ON session_log(user_id, completed_at);
