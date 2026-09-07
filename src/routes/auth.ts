import { randomUUID } from 'node:crypto'
import bcrypt from 'bcrypt'
import { Router } from 'express'
import { z } from 'zod'
import { db, type UserRow } from '../db/client'
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
import { validate, validated } from '../lib/http'
import { signToken } from '../middleware/auth'
import { refillSlots } from '../services/slotRefill'

const BCRYPT_COST = 12

const credentials = z.object({
  email: z.email(),
  password: z.string().min(8),
  timezone: z.string().min(1).optional(),
  translation: z.string().min(1).optional(),
})

export const authRouter = Router()

authRouter.post('/signup', validate(credentials), async (req, res) => {
  const body = validated(req, credentials)
  const { password, timezone, translation } = body
  const email = body.email.trim().toLowerCase()

  if (translation !== undefined && !isTranslation(translation)) {
    throw new BadRequestError('unknown translation')
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email)
  if (existing) throw new ConflictError('email already registered')

  const id = randomUUID()
  db.prepare(
    `INSERT INTO users (id, email, password_hash, created_at, timezone, translation)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    email,
    await bcrypt.hash(password, BCRYPT_COST),
    new Date().toISOString(),
    timezone ?? 'UTC',
    translation ? normalizeTranslation(translation)! : DEFAULT_TRANSLATION,
  )

  // All 3 slots are live immediately — there is no ramp-up.
  refillSlots(id)

  res.status(201).json({ token: signToken(id), userId: id })
})

// Terse: login must not describe which field was wrong.
authRouter.post(
  '/login',
  validate(credentials, { terse: true }),
  async (req, res) => {
    const body = validated(req, credentials)
    const email = body.email.trim().toLowerCase()

    const user = db
      .prepare('SELECT * FROM users WHERE email = ?')
      .get(email) as UserRow | undefined
    // Compare against a dummy hash when the user is missing so that a bad email
    // and a bad password take the same amount of time.
    const hash =
      user?.password_hash ??
      '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv'
    const ok = await bcrypt.compare(body.password, hash)

    if (!user || !ok) throw new UnauthorizedError('invalid credentials')

    res.json({ token: signToken(user.id), userId: user.id })
  },
)
