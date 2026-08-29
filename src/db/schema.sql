-- Per-user state only. Verse text and decoys live in src/data/translations/
-- and are never written to the database. user_verse.verse_id is a
-- translation-independent slug, so changing users.translation swaps the words
-- a user sees without touching a single row of their progress.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,           -- uuid
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,      -- ISO 8601
  timezone TEXT NOT NULL DEFAULT 'UTC', -- for "day" boundary calculations
  translation TEXT NOT NULL DEFAULT 'WEB'  -- code from data/translations/catalog.ts;
                                           -- selects which text and decoys are served
);

-- One row per verse a user has started. Holds both the learning-tier state and
-- the review schedule: a verse is only ever in one regime at a time, so there
-- is no separate schedule table.
CREATE TABLE IF NOT EXISTS user_verse (
  id TEXT PRIMARY KEY,           -- uuid
  user_id TEXT NOT NULL REFERENCES users(id),
  verse_id TEXT NOT NULL,        -- references data/verses.ts id, not a DB fk;
                                 -- the same slug in every translation
  stage TEXT NOT NULL,           -- 'learning_light' | 'learning_medium' |
                                 -- 'learning_heavy' | 'review' | 'mastered'.
                                 -- Graduation is an event stamped in
                                 -- graduated_at, not a stage.
  consecutive_correct INTEGER NOT NULL DEFAULT 0,   -- zeroed by any wrong answer
  consecutive_incorrect INTEGER NOT NULL DEFAULT 0, -- zeroed by any correct answer
  streak_date TEXT,              -- local date consecutive_correct was accrued
                                 -- on; learning stages only, where the run must
                                 -- land inside a single calendar day
  interval_days INTEGER,         -- review/mastered only; NULL in a learning slot
  due_at TEXT,                   -- local date (YYYY-MM-DD); NULL = not scheduled
  last_upgrade_date TEXT,        -- local date; caps tier changes at one per day
  last_downgrade_date TEXT,      -- local date; same cap, other direction
  needs_relearning INTEGER NOT NULL DEFAULT 0,  -- 1 = pulled out of review,
                                                -- waiting for a learning slot
  relearning_queued_at TEXT,     -- ISO 8601; orders the relearning queue
  slot INTEGER,                  -- 1, 2, or 3 while in an active learning
                                 -- slot; NULL once graduated
  activated_at TEXT NOT NULL,
  graduated_at TEXT,
  UNIQUE(user_id, verse_id)
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
                                 -- drives the streak on GET /api/me
);

-- Access-path indexes. Each one backs a lookup the app actually makes: session
-- build reads user_verse by user, slot refill pops the oldest queued relearner,
-- verse detail reads attempt history, and the profile reads session_log by user
-- for the streak.
CREATE INDEX IF NOT EXISTS idx_user_verse_user ON user_verse(user_id);
CREATE INDEX IF NOT EXISTS idx_user_verse_relearn
  ON user_verse(user_id, needs_relearning, relearning_queued_at);
CREATE INDEX IF NOT EXISTS idx_attempt_uv ON attempt(user_verse_id, created_at);
CREATE INDEX IF NOT EXISTS idx_session_log_user ON session_log(user_id, completed_at);
