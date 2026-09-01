import request from 'supertest'
import { createApp } from '../src/app'
import { db, migrate } from '../src/db/client'

/** Shared Express app for every test file — supertest drives it in-process. */
export const app = createApp()

/** Applies schema.sql to this file's fresh in-memory database. Call once per file, in beforeAll. */
export function initDb(): void {
  migrate()
}

/** Wipes every table so tests within a file don't see each other's data. */
export function resetDb(): void {
  db.exec(
    `DELETE FROM attempt;
     DELETE FROM session_log;
     DELETE FROM user_queue;
     DELETE FROM user_verse;
     DELETE FROM users;`,
  )
}

let emailCounter = 0

/** A fresh, never-before-used email for each call. */
export function uniqueEmail(): string {
  emailCounter += 1
  return `user${emailCounter}@example.com`
}

export interface SignupOptions {
  email?: string
  password?: string
  timezone?: string
  translation?: string
}

export interface SignupResult {
  token: string
  userId: string
  email: string
}

/** Signs up a new user and returns a ready-to-use bearer token. Throws on failure so a broken fixture fails loudly instead of producing confusing downstream test failures. */
export async function signup(
  overrides: SignupOptions = {},
): Promise<SignupResult> {
  const body: Record<string, string> = {
    email: overrides.email ?? uniqueEmail(),
    password: overrides.password ?? 'password123',
  }
  if (overrides.timezone !== undefined) body.timezone = overrides.timezone
  if (overrides.translation !== undefined)
    body.translation = overrides.translation

  const res = await request(app).post('/auth/signup').send(body)
  if (res.status !== 201) {
    throw new Error(
      `test fixture signup failed: ${res.status} ${JSON.stringify(res.body)}`,
    )
  }
  return { token: res.body.token, userId: res.body.userId, email: body.email }
}

/** A supertest wrapper that always sends the given bearer token. */
export function authed(token: string) {
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`)
  return {
    get: (url: string) => auth(request(app).get(url)),
    post: (url: string) => auth(request(app).post(url)),
    put: (url: string) => auth(request(app).put(url)),
    patch: (url: string) => auth(request(app).patch(url)),
    delete: (url: string) => auth(request(app).delete(url)),
  }
}
