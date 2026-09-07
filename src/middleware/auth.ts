import type { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { UnauthorizedError } from '../lib/errors'

/** Long-lived because there are no refresh tokens: expiry means a fresh login. */
const TOKEN_TTL = '30d'

declare global {
  namespace Express {
    interface Request {
      userId?: string
      /** The `tv` claim the presented token carried. */
      tokenVersion?: number
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

/**
 * `tokenVersion` has no default on purpose: every caller has to name the value
 * it is minting against, so a site that forgets can't quietly issue a token
 * that is already stale for anyone who has ever reset their password.
 */
export function signToken(userId: string, tokenVersion: number): string {
  return jwt.sign({ sub: userId, tv: tokenVersion }, jwtSecret(), {
    expiresIn: TOKEN_TTL,
  })
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
  let tv: unknown
  try {
    const payload = jwt.verify(header.slice('Bearer '.length), jwtSecret())
    sub = typeof payload === 'string' ? undefined : payload.sub
    tv = typeof payload === 'string' ? undefined : payload.tv
  } catch {
    throw new UnauthorizedError('invalid token')
  }

  if (typeof sub !== 'string') throw new UnauthorizedError('invalid token')

  req.userId = sub
  // Anything but a number reads as 0, matching users.token_version's default:
  // tokens signed before the claim existed stay valid across the deploy.
  req.tokenVersion = typeof tv === 'number' ? tv : 0
  next()
}

/**
 * Rejects a token the account has since revoked. Mounted after `loadUser`,
 * whose `users` read it borrows — so revocation costs no extra query.
 *
 * A missing user is loadUser's deliberate case and is left alone here: a token
 * outliving its account is still a 404 from the routes that need the record.
 */
export function requireCurrentToken(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (req.user && req.user.tokenVersion !== (req.tokenVersion ?? 0)) {
    throw new UnauthorizedError('session expired')
  }
  next()
}

/** Narrowing helper for handlers mounted behind `requireAuth`. */
export function userId(req: Request): string {
  if (!req.userId) {
    throw new Error('requireAuth did not run on this route')
  }
  return req.userId
}
