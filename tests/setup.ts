// Runs before this file's module graph is imported, so app.ts/db/client.ts
// pick up an isolated in-memory database and a usable JWT secret.
process.env.JWT_SECRET = 'test-secret'
process.env.DB_PATH = ':memory:'

import { afterEach, vi } from 'vitest'

// Harmless when a test never enabled fake timers; prevents one test's
// vi.setSystemTime from bleeding into the next.
afterEach(() => {
  vi.useRealTimers()
})
