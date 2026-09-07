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
 * One `users` read per request, shared by everything behind it. A missing user
 * is left undefined rather than rejected: a token outliving its account is a
 * 404 from the routes that need the record and a harmless default elsewhere.
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
