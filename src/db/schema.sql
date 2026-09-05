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
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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

-- A user's custom ordering of the practice queue. No row = the default order
-- (in-progress verses first, then untouched ones, curriculum order within
-- each). verse_order is a JSON array of verse ids; ids in it that are
-- currently slotted or memorized are simply skipped when the queue is read,
-- and eligible verses missing from it are merged back in — see
-- services/queue.ts for the exact rules.
CREATE TABLE IF NOT EXISTS user_queue (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  verse_order TEXT NOT NULL,     -- JSON array of verse ids
  updated_at TEXT NOT NULL       -- ISO 8601
);

CREATE TABLE IF NOT EXISTS attempt (
  id TEXT PRIMARY KEY,
  user_verse_id TEXT NOT NULL REFERENCES user_verse(id) ON DELETE CASCADE,
  exercise_type TEXT NOT NULL,   -- 'tile_fill_blank' | 'type_fill_blank'
  correct INTEGER NOT NULL,      -- 0 or 1
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  completed_at TEXT NOT NULL     -- one row per completed daily session;
                                 -- drives the streak on GET /api/me
);

-- Access-path indexes. Each backs a lookup the app makes: session build and the
-- queue both read user_verse by user, verse detail reads attempt history, and
-- the profile reads session_log by user for the streak.
CREATE INDEX IF NOT EXISTS idx_user_verse_user ON user_verse(user_id);

-- Currently unused: refill once popped the oldest queued relearner, but it now
-- reads the stored queue order (services/queue.ts) and finds relearners through
-- idx_user_verse_user instead. Kept because existing databases already have it
-- and dropping it needs a migration this schema has no mechanism for.
CREATE INDEX IF NOT EXISTS idx_user_verse_relearn
  ON user_verse(user_id, needs_relearning, relearning_queued_at);
CREATE INDEX IF NOT EXISTS idx_attempt_uv ON attempt(user_verse_id, created_at);
CREATE INDEX IF NOT EXISTS idx_session_log_user ON session_log(user_id, completed_at);

-- Today's exercise queue, materialized so a session survives the app being
-- closed mid-way. Only identity and order are stored: the blanks and word bank
-- are regenerated on every read, at the verse's *current* stage, so a verse
-- that upgrades mid-session still gets harder repetitions. Rows are appended,
-- never renumbered or removed within a day, which is what keeps the order
-- stable across calls and stops an answered review from vanishing from the list.
CREATE TABLE IF NOT EXISTS session_exercise (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_date TEXT NOT NULL,    -- local date (YYYY-MM-DD) in the user's timezone
  position INTEGER NOT NULL,     -- 0-based; fixed once assigned
  user_verse_id TEXT NOT NULL REFERENCES user_verse(id) ON DELETE CASCADE,
  queue TEXT NOT NULL,           -- 'review' | 'learning'
  instance INTEGER NOT NULL,     -- repetition index within the day; feeds the
                                 -- exercise seed alongside verse and stage
  completed_at TEXT,             -- ISO 8601; NULL = not answered yet
  correct INTEGER,               -- 0 or 1 once answered; NULL while outstanding.
                                 -- Added after the table shipped, so rows
                                 -- answered before then stay NULL and simply
                                 -- don't count toward the day's correct total.
  UNIQUE(user_id, session_date, position),
  -- queue is part of the identity on purpose: a review verse that fails twice
  -- is re-seated into a learning slot the same day, and its learning/instance-0
  -- item must not collide with the review/instance-0 item already planned.
  UNIQUE(user_id, session_date, user_verse_id, queue, instance)
);

CREATE INDEX IF NOT EXISTS idx_session_exercise_day
  ON session_exercise(user_id, session_date, position);

-- What moved today, so the completion screen can recap a session the user quit
-- and came back to. The client used to derive these from attempt responses and
-- hold them in memory, which lost everything earned before a reload; deriving
-- them here also means the stage a verse moved *from* is the real one rather
-- than whatever the client last fetched.
--
-- Only two paths write rows: recording an attempt, and the refill at the end of
-- POST /api/session/complete. Refills at signup and from an explicit slot swap
-- deliberately record nothing -- there is no recap being shown for those.
--
-- Day-scoped like session_exercise, and pruned alongside it.
CREATE TABLE IF NOT EXISTS session_event (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_date TEXT NOT NULL,    -- local date (YYYY-MM-DD) in the user's timezone
  created_at TEXT NOT NULL,      -- ISO 8601
  kind TEXT NOT NULL,            -- see domain/sessionEvent.ts for the vocabulary
  user_verse_id TEXT NOT NULL REFERENCES user_verse(id) ON DELETE CASCADE,
  verse_id TEXT NOT NULL,        -- slug; the human reference is rendered from
                                 -- the bank at read time, in the reader's
                                 -- current translation
  stage_from TEXT,               -- NULL for slot events
  stage_to TEXT,                 -- NULL for slot events
  slot INTEGER                   -- the slot taken, for slot events
);

CREATE INDEX IF NOT EXISTS idx_session_event_day
  ON session_event(user_id, session_date, created_at);
