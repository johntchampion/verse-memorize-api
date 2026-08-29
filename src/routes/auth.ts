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

authRouter.post('/signup', async (req, res) => {
  const parsed = credentials.safeParse(req.body)
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: 'invalid body', details: z.treeifyError(parsed.error) })
    return
  }
  const { password, timezone, translation } = parsed.data
  const email = parsed.data.email.trim().toLowerCase()

  if (translation !== undefined && !isTranslation(translation)) {
    res.status(400).json({ error: 'unknown translation' })
    return
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email)
  if (existing) {
    res.status(409).json({ error: 'email already registered' })
    return
  }

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

  // Slot 1 is assigned at signup; slots 2 and 3 unlock off session_log, so
  // this fills exactly one.
  refillSlots(id)

  res.status(201).json({ token: signToken(id), userId: id })
})

authRouter.post('/login', async (req, res) => {
  const parsed = credentials.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body' })
    return
  }
  const email = parsed.data.email.trim().toLowerCase()

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as
    | UserRow
    | undefined
  // Compare against a dummy hash when the user is missing so that a bad email
  // and a bad password take the same amount of time.
  const hash =
    user?.password_hash ??
    '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv'
  const ok = await bcrypt.compare(parsed.data.password, hash)

  if (!user || !ok) {
    res.status(401).json({ error: 'invalid credentials' })
    return
  }

  res.json({ token: signToken(user.id), userId: user.id })
})
