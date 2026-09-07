/**
 * `?translation=` overrides the account preference as a preview; it never writes
 * back. An override naming a translation that does not exist 400s here, which is
 * why every route behind this can assume `translation(req)` is a real bank.
 */
import type { NextFunction, Request, Response } from 'express'
import { BadRequestError } from '../lib/errors'
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
  _res: Response,
  next: NextFunction,
): void {
  const resolved = translationFor(req, req.user?.translation)
  if (!resolved) throw new BadRequestError('unknown translation')

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
