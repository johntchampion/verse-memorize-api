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

# Optional: daily reminders. Without these the server boots normally and
# simply doesn't send any.
npx web-push generate-vapid-keys   # paste the pair into .env as below

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
| `npm run stats`     | Usage report — see [Usage report](#usage-report) |
| `npm run typecheck` | `tsc --noEmit`                            |
| `npm test`          | Vitest suite (`npm run test:watch` to watch) |

| Env var             | Required                                      | Default                     |
| ------------------- | --------------------------------------------- | --------------------------- |
| `JWT_SECRET`        | **yes** — the server exits at boot without it | —                           |
| `PORT`              | no                                            | `3000`                      |
| `DB_PATH`           | no                                            | `./data.sqlite`             |
| `VAPID_PUBLIC_KEY`  | no — without it reminders are off             | —                           |
| `VAPID_PRIVATE_KEY` | no — without it reminders are off             | —                           |
| `VAPID_SUBJECT`     | with the keys — a real `mailto:` or `https:` contact | —                    |
| `MAILJET_API_KEY`   | no — without it password reset is off         | —                           |
| `MAILJET_SECRET_KEY`| no — without it password reset is off         | —                           |
| `MAIL_FROM_EMAIL`   | with the keys — a verified Mailjet sender     | —                           |
| `MAIL_FROM_NAME`    | no                                            | `Verse Memorize`            |
| `APP_BASE_URL`      | with the keys — the origin reset links point at | —                         |

Auth is load-bearing, so a missing `JWT_SECRET` is fatal at boot. Reminders are
not, so a deployment with **no** VAPID configuration starts anyway: the
scheduler doesn't run and `/api/push/*` answers `503`, which is what tells the
client to show the reminder toggle as unavailable rather than broken. See
[Daily reminders](#daily-reminders).

Password reset works the same way: with no Mailjet configuration the server
boots and the reset routes answer `503`. `APP_BASE_URL` is validated at boot
when mail *is* configured, because a malformed one surfaces only as a real email
pointing at `undefined/reset-password` — see [Password reset](#password-reset).

Configuration that is present but *wrong* does fail at boot. In particular
`VAPID_SUBJECT` must be a contact address that could actually receive mail:
**Apple rejects a JWT whose `sub` uses a reserved domain** (`.invalid`,
`.example`, `.test`, `.localhost`) with `403 {"reason":"BadJwtToken"}`, while
Firefox and Chrome accept it happily. A placeholder there produces a deployment
where Safari alone silently stops working, so the server refuses to start with
one rather than let you find out from a bug report.

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
  -e VAPID_PUBLIC_KEY="$VAPID_PUBLIC_KEY" \
  -e VAPID_PRIVATE_KEY="$VAPID_PRIVATE_KEY" \
  -e VAPID_SUBJECT="mailto:you@example.com" \
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
- **Generate the VAPID pair once and never rotate it.** A push service rejects
  a message signed by a key that doesn't match the one the browser subscribed
  with, so rotating silently invalidates every existing subscription: `403`s in
  the log, nothing in the UI, and every user having to re-enable a toggle they
  have no reason to touch. Treat them like `JWT_SECRET` — secret store, not a
  literal in a compose file.
- **Run exactly one container.** The reminder scheduler is a ticker inside the
  web process. Two replicas over one SQLite file would each claim correctly —
  the claim is an atomic conditional `UPDATE` — but two writers on one WAL file
  buys `SQLITE_BUSY` for nothing. This was already a single-container deploy;
  now it's a requirement rather than a coincidence.

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
All of this lives in [`Slots.ts`](./src/models/Slots.ts) and
[`PracticeQueue.ts`](./src/models/PracticeQueue.ts).

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

- **The schedule moves once per due date, not once per exercise.** An answer
  only counts while `due_at <= today`, and every counted answer pushes `due_at`
  past today — so the second and third repetitions of a verse on the same day
  are recorded as attempts and change nothing else. Three drills of a one-day
  verse in one afternoon must not buy three days of interval, and a verse that
  graduated into review this morning must not collect review credit from the
  learning repetitions still queued behind it. Practising a verse before it
  comes due is inert for the same reason. Learning tiers are deliberately _not_
  gated this way: they are meant to be drilled several times a day.
- **3 correct due dates in a row** advances one rung and resets the counter.
- **A wrong answer** resets the interval to 1 and the correct-run to 0, and
  increments a separate wrong-run. **2 missed due dates in a row** pulls the
  verse out of review entirely and queues it for the next available slot, where
  it re-enters at `learning_heavy`. While queued it has no `due_at`, so it drops
  out of the session — and, being unscheduled, is inert to further answers —
  until a slot picks it up. No count of how often a verse has been requeued is
  kept.

#### Mastered

Reached when a verse would bump past the top of the ladder — 3 correct in a row
while already at 30 days. It stays on the 30-day cadence so it doesn't go stale,
and correct answers change nothing further; mastered is the ceiling.

A single miss reverts it to `review` at interval 1, **and counts as the first of
review's two strikes** — one miss on the next due date queues it for a slot
without waiting for two fresh misses. Same-day repeats are inert here too.

### Daily reminders

An opt-in push notification, off until the user turns it on in settings.

**When it fires.** Half an hour after the time of day they last actually
started practising — so the nudge lands when they are already in the habit of
being free — but never later than **21:00 local**, because a reminder that
arrives at bedtime is one they won't act on. Precisely:

```
anchor = the first attempt on the most recent *prior* day the user
         attempted anything, within the last 90 days
due    = min(anchor + 30 minutes, 21:00), all in the user's timezone
```

The anchor is a *prior* day on purpose: practising this morning must not move
this evening's reminder. With no anchor — a new account, or one quiet for
longer than the 90-day lookback — the due time is simply 21:00. That window is
both a cost control (attempts are never pruned, so an unbounded lookup walks
the account's whole history) and the right answer: someone who hasn't practised
in three months has no habitual time left to aim at.

**When it doesn't fire.** Two suppressions, both checked at the due minute:

- a `session_log` row already exists for today's local date — they're done, and
  the day is claimed so the checks don't repeat every minute until midnight;
- they recorded an attempt in the last 30 minutes — they're practising right
  now. This one deliberately does *not* claim the day: if they stop without
  finishing, the reminder re-arms 30 minutes after their last attempt.

**At most one per user per local day.** `users.reminder_last_sent_date` holds
the local date, claimed by an atomic conditional `UPDATE` **before** any
network call. That ordering is the trade: a crash between the claim and the
send loses that day's reminder, where send-then-record would re-send it on
restart. A user who gets the same nudge three times from a crash-looping
container turns the feature off and never turns it back on, so losing a day is
the cheaper failure.

The state is per *user*, not per subscription — a phone and a laptop are two
`push_subscription` rows sharing one reminder, fanned out in parallel. A `404`
or `410` from the push service means that endpoint is dead and the row is
deleted; anything else leaves it alone and logs.

**Reading a `403`.** It means the push service rejected our credentials rather
than our request, so it arrives for every subscription on that service at once.
Two causes, told apart by the response body and by which services are affected:
a rotated VAPID key pair breaks all of them, while
`{"reason":"BadJwtToken"}` from `web.push.apple.com` alone is almost always the
`VAPID_SUBJECT` — Apple validates it and the others don't.

**Best-effort, by design.** The scheduler is a `setInterval` in the web process
([`services/reminderScheduler.ts`](./src/services/reminderScheduler.ts)), so
reminders stop while the process is down. A two-hour catch-up window covers a
deploy or a restart; it deliberately does not cover an overnight outage, since
a 21:00 reminder delivered at 07:00 is worse than none. Nothing stale survives
the night either way — the next tick falls on a new local date, and that date's
due instant is in the future.

The tick is cheap: one filtered scan of `users` a minute, and for almost every
row the answer is a string compare against `reminder_last_sent_date`. The
queries that cost something run once per opted-in user per local day, in the
minute their reminder comes due.

### Password reset

Two ways in, one flow behind them. A signed-out user asks from the login screen
(`POST /auth/forgot-password`, with an address); a signed-in user asks from
Settings (`POST /api/me/request-password-reset`, with no body, since the address
is already on the account). Both land in
[`services/passwordReset.ts`](./src/services/passwordReset.ts), so the throttle,
the expiry and the email body cannot drift apart.

The link is good for **30 minutes** and once. Only the SHA-256 of the token is
stored, so a leaked database yields nothing that can be mailed to anyone or
presented to `/auth/reset-password`. Redeeming is a conditional `UPDATE`, not a
read-then-write, so "unused" and "unexpired" are settled in one statement and
two simultaneous redemptions cannot both win.

**The public route tells you nothing about who has an account.** It answers `202
{ requested: true }` for any well-formed address and sends only if one matches.
That is only half the defence: awaiting a Mailjet round trip for known addresses
and returning instantly for unknown ones would put the same answer back into the
response time. So the send is started and deliberately not awaited, and a
delivery failure is logged rather than raised — by the time it is known, the
response has gone. A *misconfiguration* is different: `503` is raised before the
address is looked up, so it leaks nothing, and without it a deployment with no
credentials would accept resets forever and send none.

One email per account per minute, and both entry points share the key — asking
from Settings and then from the login page sends one email, not two. Over the
limit still answers `202`, because a `429` would say the address is registered.

**Completing a reset ends every other session.** `users.token_version` is
carried in every JWT as `tv`; the reset bumps it, and
[`requireCurrentToken`](./src/middleware/auth.ts) rejects any token presenting an
older one with `401 session expired`. The check rides on the `users` row
[`loadUser`](./src/middleware/loadUser.ts) already reads, so revocation costs no
extra query and the design stays stateless. The response carries a token minted
*after* the bump, which is what signs the resetting device back in.

A missing or non-numeric `tv` reads as 0, matching the column's default — so
tokens issued before the claim existed keep working across the deploy. The
regression test for that pairing is in
[`tests/migrate.test.ts`](./tests/migrate.test.ts), and it is the only thing in
the suite that can catch a missing column migration: every other test database is
built fresh from `schema.sql`, where the column is always present.

Push subscriptions deliberately survive a reset. A revoked device stops being
able to call the API but keeps receiving daily reminders; there is no device
list to make either behaviour legible, so the smaller change wins.

### Tuning constants

All of these are exported from
[`progression.ts`](./src/domain/progression.ts) — tune them there, never at a
call site.

| Constant                    | Value           | Meaning                                           |
| --------------------------- | --------------- | ------------------------------------------------- |
| `TIER_ADVANCE_THRESHOLD`    | 3               | Same-day correct run that advances a slotted tier |
| `TIER_DOWNGRADE_THRESHOLD`  | 2               | Wrong run that drops a slotted tier               |
| `INTERVAL_PROGRESSION`      | 1, 3, 7, 14, 30 | Review interval ladder, in days                   |
| `REVIEW_ADVANCE_THRESHOLD`  | 3               | Correct due dates that step one rung up           |
| `REVIEW_DEMOTION_THRESHOLD` | 2               | Missed due dates that queue a verse for relearning |

### Exercise generation

[`exerciseBuilder.ts`](./src/services/exerciseBuilder.ts) blanks words according
to the density table in [`stage.ts`](./src/domain/stage.ts):

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

[`DailySession.ts`](./src/models/DailySession.ts) decides what the day holds:
due reviews (one exercise each) plus learning verses (3 each), interleaved
round-robin **by verse** so a user never grinds the same verse back to back.

That plan is **persisted**, one `session_exercise` row per exercise, so a
session survives the app being closed part-way through. Within a day it is
append-only:

- Positions are assigned once and never renumbered, so the queue comes back in
  the same order on every call.
- Nothing is removed. An answered review whose `due_at` has moved on, or a verse
  that graduated mid-session, stays in the list marked `completed` instead of
  vanishing out from under the client.
- A slot refilled mid-session appends its three exercises to the tail, which is
  the same-day behaviour it has always had.

Only identity and order are stored. [`DailySession.ts`](./src/models/DailySession.ts)
regenerates the text, blanks and word bank on every read, at the verse's
**current** stage — so a verse that upgrades a tier partway through the session
gets harder repetitions for the rest of it.

`POST /api/attempt` marks the earliest outstanding exercise for that verse as
done and records how it was answered; there is no separate "completed" call.
Once a verse has nothing left outstanding today, further attempts on it are
simply extra practice and tick nothing off.

### What moved: session events

The completion screen recaps the session — verses that climbed a tier,
graduated, slipped, or moved into a freed slot. Those are recorded server-side,
one `session_event` row per move, because the client used to derive them by
comparing the stage it had cached against the one an attempt came back with, and
that got two things wrong. It could only remember the current sitting, so a
session resumed after a quit lost everything earned before it; and the cached
stage went stale the moment a verse upgraded, so the two remaining repetitions
of that verse re-reported a move that had already happened.

[`domain/sessionEvent.ts`](./src/domain/sessionEvent.ts) classifies a move
against the row as it actually stands, after the refill has run — which is what
lets a review verse demoted straight back into a free slot be reported once, as
a demotion, rather than as a park plus a slot fill.

Only two paths write events: recording an attempt, and the refill at the end of
`POST /api/session/complete`. The refills at signup and behind an explicit slot
swap deliberately record nothing — there is no recap being shown for those.

Events are day-scoped like the plan, and pruned alongside it. The stored row
keeps the verse slug; the human reference is rendered at read time from the bank
the reader is currently on, which is also what lets a slot event name the verse
that arrived rather than only the slot it landed in.

---

## Project layout

```
src/
  models/                   The things the app is about, as classes
    User.ts                 Timezone, translation, password checks
    UserVerse.ts            One user's progress against one verse
    Streak.ts               Consecutive completed days
    Slots.ts                The 3 learning slots: refill and swap
    PracticeQueue.ts        Queue membership and ordering
    DailySession.ts         The day's plan, fixed once and resumable
    PracticeDrill.ts        The ?practice=true drill
    SessionExercise.ts      Rendering one exercise
    SessionEvent.ts         A recorded move, and its wire shape
    AttemptHistory.ts       A verse's attempts, tallied
  repositories/             Every SQL statement, one module per table
  controllers/              One per resource; request in, payload out
  views/                    Composite JSON payloads spanning models
  routes/                   Path -> controller, plus the zod schema
  schemas.ts                Every request body shape
  domain/                   Pure rules the models delegate to
    progression.ts          Attempt -> next-state rules + constants
    stage.ts                The Stage union, the ladder, blank density
    sessionEvent.ts         "What did this attempt move" classifier
    sessionExercise.ts      PlannedExercise shape
    reminder.ts             When a reminder is due, and whether to send
  services/                 Orchestration across models
    attemptRecorder.ts      The attempt transaction
    exerciseBuilder.ts      Blanking and word banks
    reminderScheduler.ts    The daily ticker
    reminderSchedule.ts     Due-instant calculation and its cache
    pushSender.ts           Web Push delivery and fan-out
    vapid.ts                VAPID configuration
  db/
    schema.sql              Tables; applied at boot, all IF NOT EXISTS
    client.ts               Connection and migrate()
    rows.ts                 Raw row shapes, one per table
    introspect.ts           Table and column existence checks
    migrations/             Column adds, cascade rebuilds, the guard
  lib/                      dates, errors, http, translation, words, random
  middleware/               auth, loadUser, translation
  data/                     The verse bank, themes, connectors
  scripts/stats.ts          Admin usage report
  app.ts / server.ts        Wiring and boot
```

The boundaries are the point:

- **`models/`** hold the behaviour. A `UserVerse` knows whether it is due; a
  `PracticeQueue` knows its own order; a `DailySession` knows what today holds.
- **`repositories/`** own every SQL statement and every row-to-model mapping.
  Nothing above them sees a snake_case row, and nothing below them knows a
  business rule.
- **`domain/`** is pure. No database, no clock, no Express — `progression.ts`
  takes a verse's progress and an answer and returns the progress that should
  replace it, so the rules test without a server.
- **`controllers/`** and **`views/`** turn a request into a payload. Controllers
  never build a status code: they throw an `ApiError` and `app.ts` turns it into
  the response.
- **`routes/`** are a path, a schema and a controller call. All seven together
  are under 200 lines.

---

## API

`/auth/*` is public. Everything under `/api/*` requires
`Authorization: Bearer <token>` (30-day JWT, no refresh tokens).

| Method  | Path                    | Purpose                                         |
| ------- | ----------------------- | ----------------------------------------------- |
| `POST`  | `/auth/signup`          | Create user, assign slot 1, return JWT          |
| `POST`  | `/auth/login`           | Return JWT                                      |
| `POST`  | `/auth/forgot-password` | Email a reset link; `202` whether or not the address is registered |
| `POST`  | `/auth/reset-password`  | Spend a link, set the password, return a fresh JWT |
| `POST`  | `/api/me/request-password-reset` | Email a reset link to the address on the account |
| `GET`   | `/api/session/today`    | Today's resumable exercise queue, or a practice drill |
| `POST`  | `/api/attempt`          | Record one attempt; returns updated verse state |
| `POST`  | `/api/session/complete` | Log the session, top up any empty slots         |
| `GET`   | `/api/verses`           | Full bank with per-user status                  |
| `GET`   | `/api/verses/:id`       | One verse + that user's history                 |
| `GET`   | `/api/translations`     | Translations a user can pick between            |
| `GET`   | `/api/me`               | Profile, streak, slot state                     |
| `PATCH` | `/api/me`               | Update timezone, translation and/or reminders   |
| `GET`   | `/api/queue`            | The practice queue, in order, plus themes       |
| `PUT`   | `/api/queue`            | Store a custom queue order                      |
| `DELETE`| `/api/queue`            | Reset the queue to the default order            |
| `POST`  | `/api/queue/theme`      | Move a theme to the front of the queue          |
| `POST`  | `/api/queue/next`       | Move one verse to the next-up spot              |
| `POST`  | `/api/slots/replace`    | Put a verse into a chosen slot                  |
| `GET`   | `/api/push/key`         | VAPID public key for `PushManager.subscribe`    |
| `POST`  | `/api/push/subscribe`   | Register this browser for pushes                |
| `POST`  | `/api/push/unsubscribe` | Drop one of your own registrations              |
| `POST`  | `/api/push/test`        | Send the reminder to your own devices now       |

`GET /api/session/today` returns the day's queue in a fixed order, each exercise
carrying `completed`, `correct` and the verse's `userVerse` progress (the same
snake_case shape `POST /api/attempt` returns), plus `count`, `completedCount`
and `correctCount` on the body. A client that quit mid-session re-fetches and
skips to the first `completed: false`.

It also returns `events`: everything the day has moved so far, so a resumed
session can recap the whole day rather than only the part of it the client was
open for. The two mutating endpoints return **deltas** instead — `POST
/api/attempt` returns just what that attempt moved, and `POST
/api/session/complete` just the slots that call topped up — so a client stepping
through a session appends as it goes and picks up the rest on resume. Each event
carries `kind`, `reference`, `verseId`, `stageFrom`, `stageTo`, `slot` and
`createdAt`; the kinds are listed in [`domain/sessionEvent.ts`](./src/domain/sessionEvent.ts).

`GET /api/session/today?practice=true` (or `=1`) instead returns a short drill —
one exercise per slotted verse, in slot order, always `completed: false`. It is
meant to be called repeatedly through the day: it neither reads nor writes the
day's plan, and its blanks are re-randomised on every call rather than seeded.
The response shape is otherwise identical, with `practice` saying which of the
two you got. A drill's `events` and `correctCount` are always empty: its recap
is its own, and the day's events are not its to report. Its attempts are still
recorded, so a later resume of the day's session includes what the drill moved.

`GET /api/verses`, `/api/verses/:id` and `/api/session/today` accept an optional
`?translation=CODE` override and echo back the `translation` they served. `PATCH
/api/me` takes `timezone`, `translation`, `remindersEnabled`, or any combination
— at least one is required, and an unknown timezone or translation is a `400`. `POST /auth/signup` accepts an optional
`translation` alongside `timezone`.

Browse statuses are `not_started` / `active` / `review` / `mastered`, with
`graduatedAt` alongside so the UI can badge graduation as an achievement.
Every verse's text is served regardless of status — nothing is locked.

`POST /api/session/complete` is idempotent per calendar day in the user's
timezone — calling it twice won't double-count toward the streak.

The `/api/push/*` endpoints all answer `503` on a deployment with no VAPID keys.
`POST /api/push/subscribe` takes a `PushSubscription.toJSON()` body verbatim and
is idempotent on its `endpoint`, so a client may re-send it on every launch —
which it should, since only the browser knows whether its subscription survived.
Unsubscribe is scoped to the caller, and `POST /api/push/test` can only ever
address the caller's own devices; it returns `{ sent, removed, failed }`.
Turning `remindersEnabled` off leaves the subscriptions in place, so switching
it back on costs no permission prompt and no re-subscribe.

The three password-reset endpoints all answer `503` on a deployment with no
Mailjet configuration. `POST /auth/forgot-password` answers `202
{ requested: true }` for any well-formed address, registered or not, and never
waits for the send — see [Password reset](#password-reset).

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

Change the exported constants in `domain/progression.ts` (streak thresholds,
interval ladder) or `STAGE_RULES` in `exerciseBuilder.ts` (blank densities). Both are
single-source; nothing hardcodes these numbers elsewhere.

### Usage report

`src/scripts/stats.ts` prints account count plus a per-account table (created
date, last exercise attempt, streak, verses started/practiced, attempts in
the past 7 days), read directly off `DB_PATH` in readonly mode. Run it inside
a running container:

```bash
docker exec -it <container> node dist/scripts/stats.js
# or
docker exec -it <container> npm run stats
```

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
DELETE FROM session_event;
DELETE FROM session_exercise;
DELETE FROM session_log;
DELETE FROM user_queue;
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

`migrate()` **refuses** a database written before the progression rewrite —
one with a `review_schedule` table, or a `user_verse.strength` or
`correct_streak_in_tier` column. Because every statement is `IF NOT EXISTS`, the
current schema cannot reshape that file's `user_verse` table, so it would keep
running without the scheduling columns (`due_at`, `interval_days`,
`streak_date`, `needs_relearning`) and fail later, far from the cause.

The check runs before any schema is applied, so a rejected file is left exactly
as it was rather than half-migrated, and it happens at boot in `server.ts`
before the port opens. There is no upgrade path — the old 0-100 strength score
cannot be converted into the streak counters and interval ladder that replaced
it — so move the file aside and let a fresh one be created.

A schema change that isn't additive but *is* losslessly convertible — like
adding `ON DELETE CASCADE` to a foreign key — doesn't need that reject-and-recreate
treatment. Instead it rebuilds the affected table(s) in place: create a shadow
table with the new constraint, copy the rows across, drop the old table, rename
the shadow into place, and reapply any indexes (`DROP TABLE` removes those too).
`migrateAddCascadeDeletes()` in `client.ts` is the worked example — it's guarded
by a `PRAGMA foreign_key_list` check so it only runs once per database, and
every foreign key in `schema.sql` now cascades: deleting a `users` row or a
`user_verse` row removes its dependent rows automatically.

Adding a stage is deliberately compile-checked: widen `Stage` in `domain/stage.ts`
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
  differ anyway because they're chosen from the resolved wording. Practice mode
  is the one exception: it passes a random `instance` so two drills in a row
  don't blank the same words.
- **Where an exercise is in the day's queue is stored; what it looks like is
  not.** `session_exercise` pins identity and order only. That's why a verse can
  change stage mid-session without disturbing the queue, and why the blanks a
  user saw before quitting aren't the blanks they come back to.
- **Timezone drives every day boundary** — due dates, streaks, and session
  idempotency all go through `lib/dates.ts` using `users.timezone`. Don't compare
  raw timestamps for "same day".
- **A review's schedule advances on due dates, not on exercises.** `isDue()` in
  `progression.ts` gates both `advanceReview` and `advanceMastered`, and it's
  the same predicate `DailySession` uses to decide what belongs in a day — so
  the schedule advances exactly when the verse was scheduled. Extra repetitions
  are still recorded in `attempt` and still tick the day's session off; they
  just don't move `interval_days`, `due_at` or either streak counter.
- **Missed reviews aren't swept.** An overdue verse stays in the queue and only
  changes state when the user actually attempts it. Nothing penalises absence.
- **A verse queued for relearning can wait indefinitely.** It only re-enters
  learning when a slot opens, which happens when some _other_ verse graduates.
  A user with three slow slots and a failed review sits with it parked.
- **Timezone changes are retroactive.** `last_upgrade_date`, `last_downgrade_date`
  and `streak_date` are local dates written at the time of the attempt, so moving
  timezone can make a day cap look already-used or already-expired. It's a
  once-in-a-while event and self-corrects the next day.
- **Reminders are best-effort.** The day is claimed before the send, so a crash
  in between loses that reminder rather than duplicating it, and a process down
  over someone's due minute drops their day past the two-hour catch-up window.
  Timezone changes are retroactive here too: moving across a date boundary can
  suppress or duplicate exactly one day, and self-corrects the next.
- **There is no index on `attempt(created_at)`, deliberately.** The selective
  predicate in every reminder query is `user_verse.user_id`, so a
  `created_at`-first index would force a scan of every user's attempts in the
  window before filtering — a cost with no benefit. It becomes the right index
  only if the scheduler is ever rewritten to compute anchors for all users in
  one batched pass, which is the escape hatch if this ever serves thousands of
  accounts rather than dozens.
- **Dead push endpoints are only collected on `404`/`410`.** There is no
  failure counter: a column written on every send that nothing reads is cruft
  until an endpoint that `500`s forever is actually observed.

### Not built (out of scope for v1)

Multiple verse sets · admin UI for verses · Postgres migration ·
per-verse translation overrides · a user-chosen reminder time (the derived rule
is the feature; an override doubles the stored state, the UI and the tests).
