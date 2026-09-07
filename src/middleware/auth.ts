import type { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { UnauthorizedError } from '../lib/errors'

/** Long-lived because there are no refresh tokens: expiry means a fresh login. */
const TOKEN_TTL = '30d'

declare global {
  namespace Express {
    interface Request {
      userId?: string
    }
  }
}

export function jwtSecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    throw new Error('JWT_SECRET is not set')
  }
  return secret
}

export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, jwtSecret(), { expiresIn: TOKEN_TTL })
}

/** Verifies the bearer token and attaches `req.userId`. Guards all /api/*. */
export function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const header = req.get('authorization')
  if (!header?.startsWith('Bearer ')) {
    throw new UnauthorizedError('missing bearer token')
  }

  let sub: unknown
  try {
    const payload = jwt.verify(header.slice('Bearer '.length), jwtSecret())
    sub = typeof payload === 'string' ? undefined : payload.sub
  } catch {
    throw new UnauthorizedError('invalid token')
  }

  if (typeof sub !== 'string') throw new UnauthorizedError('invalid token')

  req.userId = sub
  next()
}

/** Narrowing helper for handlers mounted behind `requireAuth`. */
export function userId(req: Request): string {
  if (!req.userId) {
    throw new Error('requireAuth did not run on this route')
  }
  return req.userId
}
