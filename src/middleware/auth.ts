import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

// 30-day JWT, no refresh tokens.
const TOKEN_TTL = '30d';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not set');
  }
  return secret;
}

export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, jwtSecret(), { expiresIn: TOKEN_TTL });
}

/** Verifies the bearer token and attaches `req.userId`. Guards all /api/*. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }

  try {
    const payload = jwt.verify(header.slice('Bearer '.length), jwtSecret());
    const sub = typeof payload === 'string' ? undefined : payload.sub;
    if (typeof sub !== 'string') {
      res.status(401).json({ error: 'invalid token' });
      return;
    }
    req.userId = sub;
    next();
  } catch {
    res.status(401).json({ error: 'invalid token' });
  }
}

/** Narrowing helper for handlers mounted behind `requireAuth`. */
export function userId(req: Request): string {
  if (!req.userId) {
    throw new Error('requireAuth did not run on this route');
  }
  return req.userId;
}
