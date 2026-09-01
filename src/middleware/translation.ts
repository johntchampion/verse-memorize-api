/**
 * Resolves the translation a request should be served in, once, and attaches it
 * to the request — the same shape as `requireAuth` attaching `req.userId`.
 *
 * `?translation=` overrides the account preference as a preview; it never
 * writes back, so a client can show a verse in another translation without
 * committing the user to it. An override naming a translation that does not
 * exist is a client error and 400s here, which is why every route behind this
 * middleware can assume `translation(req)` is a real bank. An unrecognised
 * *stored* value is not the caller's fault and falls back to the default.
 */
import type { NextFunction, Request, Response } from 'express'
import { db, type UserRow } from '../db/client'
import { translationFor } from '../lib/translation'

declare global {
  namespace Express {
    interface Request {
      translation?: string
    }
  }
}

export function resolveTranslation(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const user = db
    .prepare('SELECT translation FROM users WHERE id = ?')
    .get(req.userId) as Pick<UserRow, 'translation'> | undefined

  const resolved = translationFor(req, user?.translation)
  if (!resolved) {
    res.status(400).json({ error: 'unknown translation' })
    return
  }

  req.translation = resolved
  next()
}

/** Narrowing helper for handlers mounted behind `resolveTranslation`. */
export function translation(req: Request): string {
  if (!req.translation) {
    throw new Error('resolveTranslation did not run on this route')
  }
  return req.translation
}
