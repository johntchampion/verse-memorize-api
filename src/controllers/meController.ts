import type { Request } from 'express'
import { isTranslation, normalizeTranslation } from '../data/verses'
import {
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
} from '../lib/errors'
import { userId } from '../middleware/auth'
import { User } from '../models/User'
import * as users from '../repositories/userRepository'
import type { DeleteAccountInput, ProfilePatch } from '../schemas'
import { assertMailConfigured } from '../services/mailer'
import { issueResetFor } from '../services/passwordReset'
import { profileView } from '../views/profileView'

export function show(req: Request) {
  const profile = profileView(userId(req))
  if (!profile) throw new NotFoundError('user not found')
  return profile
}

/** True when `Intl` recognises the timezone — the same check dates.ts relies on. */
function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

/**
 * `timezone` drives every day-boundary calculation. Changing `translation`
 * touches no progress at all — user_verse rows key off a translation-independent
 * verse id. Turning `remindersEnabled` off leaves push subscriptions in place,
 * so switching it back on costs no permission prompt: the scheduler gates on
 * this flag, not on having a device.
 */
export function update(req: Request, body: ProfilePatch) {
  const id = userId(req)
  const { timezone, translation, remindersEnabled } = body

  if (timezone !== undefined && !isValidTimezone(timezone)) {
    throw new BadRequestError('unknown timezone')
  }
  if (translation !== undefined && !isTranslation(translation)) {
    throw new BadRequestError('unknown translation')
  }

  const updated = users.updateSettings(id, {
    timezone,
    translation:
      translation === undefined
        ? undefined
        : normalizeTranslation(translation)!,
    remindersEnabled,
  })
  if (!updated) throw new NotFoundError('user not found')

  return profileView(id)
}

/**
 * Deleting the users row is enough on its own: every dependent table is
 * ON DELETE CASCADE in schema.sql, proven by cascadeDelete.test.ts.
 */
export async function deleteAccount(req: Request, body: DeleteAccountInput) {
  const id = userId(req)

  const row = users.findById(id)
  if (!row) throw new NotFoundError('user not found')

  const ok = await new User(row).verifyPassword(body.password)
  if (!ok) throw new UnauthorizedError('invalid password')

  users.remove(id)
  return { deleted: true }
}

/**
 * Mails a reset link to the address already on file — the signed-in half of the
 * flow, so nothing is typed and nothing can be typed wrong. Same throttle as
 * the public route, keyed on the same user, so a signed-in caller can't mail
 * their own inbox in a loop.
 */
export function requestPasswordReset(req: Request) {
  assertMailConfigured()

  // loadUser already read this row; a missing one is a token that outlived its
  // account, which is the 404 loadUser deliberately defers to the routes.
  if (!req.user) throw new NotFoundError('user not found')

  issueResetFor(req.user)
  return { requested: true }
}
