import { Router } from 'express'
import * as auth from '../controllers/authController'
import { validate, validated } from '../lib/http'
import { credentials } from '../schemas'

export const authRouter = Router()

authRouter.post('/signup', validate(credentials), async (req, res) => {
  res.status(201).json(await auth.signup(validated(req, credentials)))
})

// Terse: login must not describe which field was wrong.
authRouter.post(
  '/login',
  validate(credentials, { terse: true }),
  async (req, res) => {
    res.json(await auth.login(validated(req, credentials)))
  },
)
