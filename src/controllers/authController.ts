import bcrypt from 'bcrypt'
import {
  DEFAULT_TRANSLATION,
  isTranslation,
  normalizeTranslation,
} from '../data/verses'
import { db } from '../db/client'
import {
  BadRequestError,
  ConflictError,
  UnauthorizedError,
} from '../lib/errors'
import { hashToken } from '../lib/tokens'
import { signToken } from '../middleware/auth'
import { Slots } from '../models/Slots'
import { User } from '../models/User'
import * as resets from '../repositories/passwordResetRepository'
import * as users from '../repositories/userRepository'
import type {
  Credentials,
  ForgotPasswordInput,
  ResetPasswordInput,
} from '../schemas'
import { assertMailConfigured } from '../services/mailer'
import { issueResetFor } from '../services/passwordReset'

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

  // 0 because users.create doesn't write token_version, so the row takes the
  // schema default. The two have to stay in sync.
  return { token: signToken(id, 0), userId: id }
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

  return { token: signToken(row.id, row.token_version), userId: row.id }
}

/**
 * The same 202 whether or not the address has an account, so this cannot be
 * used to find out which addresses are registered. The 503 above it is safe to
 * surface for the same reason — it is raised before the lookup and says nothing
 * about the address — and without it a deployment with no Mailjet credentials
 * would accept resets forever and send none.
 */
export function forgotPassword(body: ForgotPasswordInput) {
  assertMailConfigured()

  const email = body.email.trim().toLowerCase()
  const row = users.findByEmail(email)
  if (row) issueResetFor(new User(row))

  return { requested: true }
}

/**
 * Spends the token and rotates the password in one transaction, so a redeemed
 * token can never be left behind by a half-applied reset. Every other session
 * dies with the version bump; the caller gets a token minted after it, which is
 * what signs this device back in.
 */
const applyReset = db.transaction(
  (tokenHash: string, passwordHash: string, now: string) => {
    const reset = resets.redeem(tokenHash, now)
    if (!reset) throw new BadRequestError('reset link is invalid or expired')

    users.updatePasswordHash(reset.user_id, passwordHash)
    resets.supersedeOutstanding(reset.user_id, now)

    return {
      userId: reset.user_id,
      version: users.bumpTokenVersion(reset.user_id),
    }
  },
)

export async function resetPassword(body: ResetPasswordInput) {
  // Hashed before the transaction opens: db.transaction() takes a synchronous
  // function and would commit out from under an awaited body.
  const passwordHash = await bcrypt.hash(body.password, BCRYPT_COST)

  const { userId, version } = applyReset(
    hashToken(body.token),
    passwordHash,
    new Date().toISOString(),
  )

  return { token: signToken(userId, version), userId }
}
