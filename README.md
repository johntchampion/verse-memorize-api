# verse-memorize-api

Backend for a Bible-verse memorization app. It serves exercises, tracks each
user's progress through a fixed 100-verse bank, and drives a spaced-repetition
review schedule.

Node + Express + TypeScript, SQLite via `better-sqlite3`, JWT auth. One process,
one file-backed database, no external services.

This README is the reference for how the algorithm works — the rules under
[How it works](#how-it-works) are the specification, and the code comments
assume you've read them.

---

## Quick start

```bash
npm install

cat > .env <<'EOF'
JWT_SECRET=dev-secret-change-me
PORT=3000
DB_PATH=./data.sqlite
EOF

npm run dev
curl localhost:3000/health   # {"ok":true}
```

The schema is applied automatically at boot, so the database file creates itself
on first run. Then sign up and pull a session:

```bash
TOKEN=$(curl -s -X POST localhost:3000/auth/signup \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"password123","timezone":"America/Chicago"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

curl -s localhost:3000/api/session/today -H "authorization: Bearer $TOKEN"
```

| Script              | Does                                      |
| ------------------- | ----------------------------------------- |
| `npm run dev`       | Watch mode via `tsx`                      |
| `npm run build`     | `tsc` → `dist/`, plus copies `schema.sql` |
| `npm start`         | Run the built output                      |
| `npm run typecheck` | `tsc --noEmit`                            |

| Env var      | Required                                      | Default         |
| ------------ | --------------------------------------------- | --------------- |
| `JWT_SECRET` | **yes** — the server exits at boot without it | —               |
| `PORT`       | no                                            | `3000`          |
| `DB_PATH`    | no                                            | `./data.sqlite` |

---

## Docker

The `Dockerfile` is a multi-stage build: it compiles TypeScript and installs
`better-sqlite3`'s native addon in a throwaway build stage, then ships only
`dist/`, pruned production `node_modules`, and `package.json` in the runtime
image. The final image runs as a non-root user and has no build toolchain,
source, or dev dependencies in it.

Build it:

```bash
docker build -t verse-memorize-api .
```

Run it, generating a real secret and persisting the SQLite database in a named
volume so it survives container restarts/recreates:

```bash
docker volume create verse-memorize-data

docker run -d \
  --name verse-memorize-api \
  -p 3000:3000 \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  -v verse-memorize-data:/app/data \
  --restart unless-stopped \
  verse-memorize-api

curl localhost:3000/health   # {"ok":true}
```

Notes:

- `JWT_SECRET` is the only required env var — the container fails fast at boot
  without it (same as running locally). Generate it once and pass it in as a
  real secret (e.g. from your platform's secret store), not a literal in a
  Dockerfile or compose file.
- `DB_PATH` is preset to `/app/data/data.sqlite` in the image. Mount a volume
  at `/app/data` (as above) so the database isn't lost when the container is
  replaced; without it, data lives only in the container's writable layer.
- `PORT` defaults to `3000` and is what's `EXPOSE`d; map it with `-p` as needed.
- Rebuild and recreate the container to pick up code changes — there's no hot
  reload in the image (`npm run dev` is a local-only workflow).

---

## How it works

This is the part worth reading before touching anything.

### Verses are code, not data

The verse bank lives in [`src/data/translations/`](./src/data/translations) as one
JSON file per translation, loaded and validated at boot by
[`src/data/verses.ts`](./src/data/verses.ts). It is never written to the database.
There is no admin UI; **adding a verse or a translation is a code deploy.** The
database holds only per-user state, and `user_verse.verse_id` stores the slug
verbatim as a soft reference.

The bank holds 100 verses in multiple translations.

### Translations

Every translation file repeats the whole record — `id`, `reference`, `order`,
`text`, `decoys` — so a translation is one file you can read top to bottom. WEB is
the **reference translation**: its file defines which verses exist, their `order`,
their `reference`, and canonical Bible order. `validateBank()` in `verses.ts`
checks every other file against it at startup and **throws if they disagree**, so
an incomplete translation takes the server down at boot rather than serving a
half-translated session.

`decoys` are per-translation on purpose. A WEB pool dropped into a KJV exercise
leaks modern vocabulary into the tiles — `sky` sitting among KJV words when the
answer is `firmament` gives the answer away.

**Progress is translation-independent.** `user_verse.verse_id` is the same slug in
every translation and `order` is identical across files, so switching translation
changes the words a user sees and nothing else: no streak, schedule, or slot moves.
That invariant is the whole reason the validator is strict.

Which translation a request is served in:

1. `?translation=CODE` on a read endpoint, if present — a preview that never
   writes back to the account;
2. otherwise `users.translation`, defaulting to `WEB`.

An unknown code in the query string is a `400`. An unknown code _stored_ on the
account — a translation since removed from the catalog — silently falls back to
the default rather than erroring on every request.

### Slots: what a user is actively learning

A user works on **at most 3 verses at a time**. All 3 slots are live from
signup — a new user starts with the first three verses by `order` already
slotted, so their first session has something to work on in each.

When a verse graduates its slot empties and immediately refills from the front
of the **practice queue** — every verse the user hasn't memorized and isn't
holding in a slot right now. Queue membership is derived, never stored: a verse
is queued when it has no `user_verse` row yet, when it's flagged for
relearning, or when it was swapped out of a slot mid-learning (progress
saved). Only the *order* persists (`user_queue`, one JSON array per user), and
only when the user customizes it.

The default order is the curriculum with in-progress verses first: relearners
and swapped-out verses come before untouched ones (which preserves the old
relearner-priority behavior), curriculum `order` within each group. A verse
entering a slot from the queue starts at `learning_light` if untouched,
resumes its saved tier if swapped out, or re-enters at `learning_heavy`
specifically — never lower — if relearning.

The user can reorder the queue verse by verse, move a whole **theme**
([`themes.ts`](./src/data/themes.ts)) to the front, push one verse into the
next-up spot, put a verse straight into a chosen slot (the occupant steps aside
with progress saved), or reset to the default order — see the `/api/queue`
routes.

Only `/api/slots/replace` changes what's in a slot on demand. Reordering the
queue — including moving a theme to the front — never disturbs the verses
already in practice: slots refill one at a time from the new front of the queue
as their occupants graduate or get swapped out.

Once the queue is exhausted, slots just stay empty — there is no wraparound.
All of this lives in [`slotRefill.ts`](./src/services/slotRefill.ts) and
[`queue.ts`](./src/services/queue.ts).

### Stages

```
        slotted — holds one of the 3 active slots          unslotted
        ─────────────────────────────────────────          ─────────────────

learning_light ──▶ learning_medium ──▶ learning_heavy ──▶ review ──▶ mastered
               ◀──                 ◀──                ◀──        ◀──

  ──▶  learning: 3 correct in a row, within one calendar day
                 (out of learning_heavy this is graduation, and the slot empties)
       review:   3 correct in a row, any span, steps the interval up;
                 a step past 30 days becomes mastery instead
  ◀──  learning: 2 wrong in a row — learning_light is the floor
       review:   2 failed reviews, via the relearning queue, back to heavy
       mastered: a single miss, straight to review at interval 1
```

The first three are **slotted** — a verse in one of them occupies one of the
user's 3 active slots. `review` and `mastered` are unslotted, reached only by
being learned through all three slotted tiers. There is no numeric strength
score; everything is driven by streaks of consecutive answers.

**Graduation is an event, not a stage.** It stamps `graduated_at`, empties the
slot, and opens an interval-1 review — then the verse _is_ in `review`. There is
no `graduated` stage; `graduated_at` is the record that it happened. (An earlier
design had one, and because the review queue didn't select for it, graduated
verses were stranded forever.)

#### Slotted tiers

- **Up:** 3 correct **in a row within the same calendar day**. Because the run
  has to fit inside one day, `consecutive_correct` starts over each morning —
  two correct yesterday do not count toward today's three.
- **Down:** 2 wrong in a row, which _may_ span days. `learning_light` is the
  floor; two misses there change nothing.
- **At most one tier change per verse per day, in either direction.** A verse
  that has already moved today can't move again — the extra correct answers are
  just practice. Either way the streak that would have triggered the change is
  spent, so a fresh run is needed to try again.
- Any tier change resets both streaks to zero. No partial credit carries over.

#### Review

Entered at `interval_days = 1`, climbing the ladder **1 → 3 → 7 → 14 → 30**.

- **3 correct in a row** advances one rung and resets the counter. This run is
  _not_ day-constrained — reviews are spaced days apart by definition.
- **A wrong answer** resets the interval to 1 and the correct-run to 0, and
  increments a separate wrong-run. **2 wrong in a row** pulls the verse out of
  review entirely and queues it for the next available slot, where it re-enters
  at `learning_heavy`. While queued it has no `due_at`, so it drops out of the
  session until a slot picks it up. No count of how often a verse has been
  requeued is kept.

#### Mastered

Reached when a verse would bump past the top of the ladder — 3 correct in a row
while already at 30 days. It stays on the 30-day cadence so it doesn't go stale,
and correct answers change nothing further; mastered is the ceiling.

A single miss reverts it to `review` at interval 1, **and counts as the first of
review's two strikes** — one more miss right after queues it for a slot without
waiting for two fresh misses.

### Tuning constants

All of these are exported from
[`stageMachine.ts`](./src/services/stageMachine.ts) — tune them there, never at a
call site.

| Constant                    | Value           | Meaning                                           |
| --------------------------- | --------------- | ------------------------------------------------- |
| `TIER_ADVANCE_THRESHOLD`    | 3               | Same-day correct run that advances a slotted tier |
| `TIER_DOWNGRADE_THRESHOLD`  | 2               | Wrong run that drops a slotted tier               |
| `INTERVAL_PROGRESSION`      | 1, 3, 7, 14, 30 | Review interval ladder, in days                   |
| `REVIEW_ADVANCE_THRESHOLD`  | 3               | Correct reviews that step one rung up             |
| `REVIEW_DEMOTION_THRESHOLD` | 2               | Failed reviews that queue a verse for relearning  |

### Exercise generation

[`exerciseBuilder.ts`](./src/services/exerciseBuilder.ts) blanks words according
to stage:

| Stage             | Blanked | Input mode |
| ----------------- | ------- | ---------- |
| `learning_light`  | ~18%    | Tap tiles  |
| `learning_medium` | ~50%    | Tap tiles  |
| `learning_heavy`  | ~80%    | Tap tiles  |
| `review`          | 100%    | Tap tiles  |
| `mastered`        | 100%    | Typed      |

Below 100% density, content words are blanked before connectors (there's a
stopword list, no NLP — the bank is small and hand-curated). Tile exercises mix
the correct words with a sample of that verse's hand-written `decoys`.

Blank selection is **deterministic**, seeded on `verseId:stage:instance`. The
`instance` counter is why the 3 repetitions of a verse within one session blank
different words while any single one stays reproducible.

[`sessionBuilder.ts`](./src/services/sessionBuilder.ts) assembles the day: due
reviews (one exercise each) plus learning verses (3 each), interleaved
round-robin **by verse** so a user never grinds the same verse back to back.

---

## Project layout

```
src/
  data/verses.ts            Loads + validates the bank; the only way in
  data/translations/        One JSON file per translation, plus catalog.ts
  db/schema.sql             Tables; applied at boot, all IF NOT EXISTS
  db/client.ts              Connection, row types, migrate()
  lib/dates.ts              Timezone-aware day boundaries
  lib/translation.ts        Resolves the translation for a request
  lib/words.ts              Shared word splitting (tiles + validator)
  middleware/auth.ts        JWT sign/verify, requireAuth
  routes/                   auth, session, verses, me, translations
  services/
    stageMachine.ts         Stage/streak/schedule transitions + constants
    slotRefill.ts           Slot fill and relearning priority
    sessionBuilder.ts       Builds today's queue
    exerciseBuilder.ts      Blanking and word banks
  app.ts / server.ts        Wiring and boot
```

Routes stay thin: validate with `zod`, check ownership, delegate to a service.
Domain rules belong in `services/`.

---

## API

`/auth/*` is public. Everything under `/api/*` requires
`Authorization: Bearer <token>` (30-day JWT, no refresh tokens).

| Method  | Path                    | Purpose                                         |
| ------- | ----------------------- | ----------------------------------------------- |
| `POST`  | `/auth/signup`          | Create user, assign slot 1, return JWT          |
| `POST`  | `/auth/login`           | Return JWT                                      |
| `GET`   | `/api/session/today`    | Today's ordered exercise queue                  |
| `POST`  | `/api/attempt`          | Record one attempt; returns updated verse state |
| `POST`  | `/api/session/complete` | Log the session, top up any empty slots         |
| `GET`   | `/api/verses`           | Full bank with per-user status                  |
| `GET`   | `/api/verses/:id`       | One verse + that user's history                 |
| `GET`   | `/api/translations`     | Translations a user can pick between            |
| `GET`   | `/api/me`               | Profile, streak, slot state                     |
| `PATCH` | `/api/me`               | Update timezone and/or translation              |
| `GET`   | `/api/queue`            | The practice queue, in order, plus themes       |
| `PUT`   | `/api/queue`            | Store a custom queue order                      |
| `DELETE`| `/api/queue`            | Reset the queue to the default order            |
| `POST`  | `/api/queue/theme`      | Move a theme to the front of the queue          |
| `POST`  | `/api/queue/next`       | Move one verse to the next-up spot              |
| `POST`  | `/api/slots/replace`    | Put a verse into a chosen slot                  |

`GET /api/verses`, `/api/verses/:id` and `/api/session/today` accept an optional
`?translation=CODE` override and echo back the `translation` they served. `PATCH
/api/me` takes `timezone`, `translation`, or both — at least one is required, and
an unknown value for either is a `400`. `POST /auth/signup` accepts an optional
`translation` alongside `timezone`.

Browse statuses are `not_started` / `active` / `review` / `mastered`, with
`graduatedAt` alongside so the UI can badge graduation as an achievement.
Every verse's text is served regardless of status — nothing is locked.

`POST /api/session/complete` is idempotent per calendar day in the user's
timezone — calling it twice won't double-count toward the streak.

---

## Common tasks

### Adding verses

A verse has to be added to **every** translation file or the server won't boot.
Append the same record to each of `src/data/translations/*.json`, varying only
`text` and `decoys`:

```json
{
  "id": "phil-4-6",
  "reference": "Philippians 4:6",
  "order": 100,
  "text": "In nothing be anxious, but in everything, by prayer and petition ...",
  "decoys": ["worried", "fasting", "supplication", "..."]
}
```

Invariants the app depends on:

1. **`id` must never change once a user has progress against it.**
   `user_verse.verse_id` stores it verbatim with no foreign key, so a renamed
   slug silently orphans that user's history.
2. `order` drives slot refill. Keep it unique, contiguous, and **identical in
   every translation** — it is what makes switching translation lossless.
3. `id`, `reference` and `order` must match the WEB file exactly. The validator
   reports every mismatch by id at startup.
4. `decoys` should be plausible for _that verse in that translation_ — they're
   what makes tile exercises non-trivial. A decoy that already appears in its own
   verse's text is rejected: it would be a correct tile.
5. Place the record in WEB in canonical Bible order; that file's layout is what
   `?orderBy=canon` returns for every translation.

### Adding a translation

1. Write `src/data/translations/<code>.json`, copying each `id` and `order`
   from the WEB file verbatim and filling in that translation's `text` for
   every verse.
2. Write a decoy pool for each verse, in that translation's own vocabulary.
3. Add an entry to `TRANSLATIONS` in
   [`src/data/translations/catalog.ts`](./src/data/translations/catalog.ts) with
   the code, display name, filename, and a licensing note.
4. Start the server. A mismatch against WEB, or a decoy that appears in its own
   verse, fails the boot with the offending ids named.

`code` is stored verbatim in `users.translation`, so it must not change once
users have selected it. Removing a translation is safe — accounts pointing at it
fall back to the default.

### Tuning the algorithm

Change the exported constants in `stageMachine.ts` (streak thresholds, interval
ladder) or `STAGE_RULES` in `exerciseBuilder.ts` (blank densities). Both are
single-source; nothing hardcodes these numbers elsewhere.

### Wiping the database

The database is one file at `DB_PATH` (`./data.sqlite` by default), opened in
WAL mode, so a live server also keeps `-wal` and `-shm` sidecar files next to
it. To start completely fresh:

```bash
# stop the server first — a running process still has the file open
rm -f data.sqlite data.sqlite-wal data.sqlite-shm   # or $DB_PATH, if you set one

npm run dev   # schema.sql re-applies at boot and recreates an empty DB
```

To wipe data but keep the file in place (e.g. you have something else open
against that path), delete every row instead of the file — `schema.sql` is all
`IF NOT EXISTS` so it won't recreate anything on next boot, but the tables
will be empty:

```bash
sqlite3 data.sqlite "
DELETE FROM attempt;
DELETE FROM session_log;
DELETE FROM user_verse;
DELETE FROM users;
"
```

Either way every user loses all progress and has to sign up again — there's no
export or backup step, so treat this as destructive.

### Changing the schema

There is **no migration tooling.** `schema.sql` is all `IF NOT EXISTS` and runs at
every boot, so new tables and indexes apply themselves — but it is inert against a
table that already exists. Adding a column therefore means two edits: the column
in `schema.sql` (for fresh databases) and an `addColumnIfMissing()` call in
`migrate()` (for existing ones). It is idempotent and needs a non-null default so
existing rows backfill; `users.translation` is the worked example. Altering or
dropping a column still needs a manual `ALTER TABLE` against the live file.

Adding a non-`.ts` file under `src/` also means updating the `build` script, which
copies `schema.sql` and `data/translations/*.json` into `dist/` by hand.

`migrate()` refuses to open a database written before the progression rewrite
(one with a `review_schedule` table or a `user_verse.strength` column) rather
than half-applying the new schema over it. Wipe the file and start fresh.

Adding a stage is deliberately compile-checked: widen `Stage` in `db/client.ts`
and `tsc` will point at every switch and lookup table that needs the new case.

---

## Things to know

- **Grading is client-side.** `POST /api/attempt` takes `correct` as a boolean
  from the client, so the client needs the answer key and can grade against the
  text from `GET /api/verses`. Moving grading server-side means changing that
  request to carry the submitted words — and, now, the translation they were
  graded against.
- **An exercise's blanks follow the text, not the translation code.** The PRNG
  seed is `verseId:stage:instance`, deliberately translation-free, so switching
  mid-session doesn't reshuffle a verse the user is partway through; the blanks
  differ anyway because they're chosen from the resolved wording.
- **Timezone drives every day boundary** — due dates, streaks, and session
  idempotency all go through `lib/dates.ts` using `users.timezone`. Don't compare
  raw timestamps for "same day".
- **Missed reviews aren't swept.** An overdue verse stays in the queue and only
  changes state when the user actually attempts it. Nothing penalises absence.
- **A verse queued for relearning can wait indefinitely.** It only re-enters
  learning when a slot opens, which happens when some _other_ verse graduates.
  A user with three slow slots and a failed review sits with it parked.
- **Timezone changes are retroactive.** `last_upgrade_date`, `last_downgrade_date`
  and `streak_date` are local dates written at the time of the attempt, so moving
  timezone can make a day cap look already-used or already-expired. It's a
  once-in-a-while event and self-corrects the next day.
- **No test suite yet** (`npm test` is a stub). Verification so far has been
  manual walks through the stage machine.

### Not built (out of scope for v1)

Push notifications · multiple verse sets · admin UI for verses · password reset ·
Postgres migration · per-verse translation overrides.
