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

The verse bank lives in [`src/data/verses.ts`](./src/data/verses.ts) and is never
written to the database. There is no admin UI; **adding a verse is a code
deploy.** The database holds only per-user state, and `user_verse.verse_id` stores
the slug verbatim as a soft reference.

> ⚠️ **The bank currently holds 3 placeholder verses, not the real 100.** Filling
> it in is outstanding work — see [Adding verses](#adding-verses).

### Slots: what a user is actively learning

A user works on **at most 3 verses at a time**. All 3 slots are live from
signup — a new user starts with the first three verses by `order` already
slotted, so their first session has something to work on in each.

When a verse graduates its slot empties and immediately refills, in this
priority order:

1. **A verse waiting to be relearned**, oldest-queued first — one that failed
   review badly enough to be pulled back into learning. It re-enters at
   `learning_heavy` specifically, never lower.
2. Otherwise the next unassigned verse by `order`.

Once the bank is exhausted and nothing is queued, slots just stay empty — there
is no wraparound. All of this lives in
[`slotRefill.ts`](./src/services/slotRefill.ts).

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

| Constant                    | Value           | Meaning                                              |
| --------------------------- | --------------- | ---------------------------------------------------- |
| `TIER_ADVANCE_THRESHOLD`    | 3               | Same-day correct run that advances a slotted tier    |
| `TIER_DOWNGRADE_THRESHOLD`  | 2               | Wrong run that drops a slotted tier                  |
| `INTERVAL_PROGRESSION`      | 1, 3, 7, 14, 30 | Review interval ladder, in days                      |
| `REVIEW_ADVANCE_THRESHOLD`  | 3               | Correct reviews that step one rung up                |
| `REVIEW_DEMOTION_THRESHOLD` | 2               | Failed reviews that queue a verse for relearning     |

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
  data/verses.ts            The verse bank — hardcoded, not in the DB
  db/schema.sql             Tables; applied at boot, all IF NOT EXISTS
  db/client.ts              Connection, row types, migrate()
  lib/dates.ts              Timezone-aware day boundaries
  middleware/auth.ts        JWT sign/verify, requireAuth
  routes/                   auth, session, verses, me
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
| `GET`   | `/api/me`               | Profile, streak, slot state                     |
| `PATCH` | `/api/me`               | Update timezone                                 |

Browse statuses are `locked` / `active` / `review` / `mastered`, with
`graduatedAt` alongside so the UI can badge graduation as an achievement.

`POST /api/session/complete` is idempotent per calendar day in the user's
timezone — calling it twice won't double-count toward the streak.

---

## Common tasks

### Adding verses

Append to `VERSES` in [`src/data/verses.ts`](./src/data/verses.ts):

```ts
{
  id: 'phil-4-6',              // stable slug
  reference: 'Philippians 4:6',
  text: 'Do not be anxious about anything, ...',
  order: 1,                    // 1..N, unique, contiguous
  decoys: ['worried', 'nothing', 'fasting', ...],  // 6-10 plausible wrong words
}
```

Three invariants the app depends on:

1. **`id` must never change once a user has progress against it.**
   `user_verse.verse_id` stores it verbatim with no foreign key, so a renamed
   slug silently orphans that user's history.
2. `order` drives slot refill. Keep it unique and contiguous.
3. `decoys` should be plausible for _that verse_ — they're what makes tile
   exercises non-trivial.

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
every boot, so new tables and indexes apply themselves — but altering or dropping
an existing column needs a manual `ALTER TABLE` against the live file. Adding a
non-`.ts` file under `src/` also means updating the `build` script, which copies
`schema.sql` into `dist/` by hand.

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
  request to carry the submitted words.
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
Postgres migration.
