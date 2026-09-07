import bcrypt from 'bcrypt'
import {
  DEFAULT_TRANSLATION,
  isTranslation,
  normalizeTranslation,
} from '../data/verses'
import {
  BadRequestError,
  ConflictError,
  UnauthorizedError,
} from '../lib/errors'
import { signToken } from '../middleware/auth'
import { Slots } from '../models/Slots'
import { User } from '../models/User'
import * as users from '../repositories/userRepository'
import type { Credentials } from '../schemas'

const BCRYPT_COST = 12

export async function signup(body: Credentials) {
  const { password, timezone, translation } = body
  const email = body.email.trim().toLowerCase()

  if (translation !== undefined && !isTranslation(translation)) {
    throw new BadRequestError('unknown translation')
  }
  if (users.existsByEmail(email)) {
    throw new ConflictError('email already registered')
  }

  const id = users.create({
    email,
    passwordHash: await bcrypt.hash(password, BCRYPT_COST),
    timezone: timezone ?? 'UTC',
    translation: translation
      ? normalizeTranslation(translation)!
      : DEFAULT_TRANSLATION,
    now: new Date().toISOString(),
  })

  // All 3 slots are live immediately — there is no ramp-up.
  new Slots(id).refill()

  return { token: signToken(id), userId: id }
}

/**
 * Compares against a dummy hash when the user is missing, so a bad email and a
 * bad password take the same amount of time.
 */
const ABSENT_USER_HASH =
  '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv'

export async function login(body: Credentials) {
  const email = body.email.trim().toLowerCase()
  const row = users.findByEmail(email)

  const ok = row
    ? await new User(row).verifyPassword(body.password)
    : await bcrypt.compare(body.password, ABSENT_USER_HASH)

  if (!row || !ok) throw new UnauthorizedError('invalid credentials')

  return { token: signToken(row.id), userId: row.id }
}
