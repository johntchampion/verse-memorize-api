import type { NextFunction, Request, Response } from 'express'
import { User } from '../models/User'
import * as users from '../repositories/userRepository'

declare global {
  namespace Express {
    interface Request {
      user?: User
    }
  }
}

/**
 * Reads the caller's row once per request and attaches it, so the handlers
 * behind it share one lookup instead of querying `users` for a timezone here
 * and a translation there.
 *
 * A missing user is left undefined rather than rejected: a token outliving its
 * account is a 404 from the routes that need the record and a harmless default
 * everywhere else, which is the behaviour the endpoints already had.
 */
export function loadUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const row = req.userId ? users.findById(req.userId) : undefined
  if (row) req.user = new User(row)
  next()
}
