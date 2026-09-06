// Runs before this file's module graph is imported, so app.ts/db/client.ts
// pick up an isolated in-memory database and a usable JWT secret.
process.env.JWT_SECRET = 'test-secret'
process.env.DB_PATH = ':memory:'

// A throwaway VAPID pair, generated for the suite and used nowhere else, so
// the push routes are exercised in their configured state. Nothing here ever
// reaches a real push service — the scheduler's sender is injected in tests.
process.env.VAPID_PUBLIC_KEY =
  'BDgmuo-9v6Gkgw866fzLi4kE3h-kNG5RjoIvdbQxbew6LV_OX0yDZaeuVQG7RT3X1-T4AeK_J6BY-rhLblO8CU8'
process.env.VAPID_PRIVATE_KEY = 'JhltUcFqa-XQpQVOjBXnCDC2R0wQYd2Zz-tXnU3VvoY'
process.env.VAPID_SUBJECT = 'mailto:test@verse-memorize.test.example.org'

import { afterEach, vi } from 'vitest'

// Harmless when a test never enabled fake timers; prevents one test's
// vi.setSystemTime from bleeding into the next.
afterEach(() => {
  vi.useRealTimers()
})
