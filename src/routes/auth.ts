import { Router } from 'express'
import * as auth from '../controllers/authController'
import { validate, validated } from '../lib/http'
import { credentials, forgotPasswordBody, resetPasswordBody } from '../schemas'

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

// 202: the link has been accepted for sending, which is all this can honestly
// claim — the send is not waited on. See services/passwordReset.ts.
authRouter.post(
  '/forgot-password',
  validate(forgotPasswordBody),
  (req, res) => {
    res
      .status(202)
      .json(auth.forgotPassword(validated(req, forgotPasswordBody)))
  },
)

authRouter.post(
  '/reset-password',
  validate(resetPasswordBody, { terse: true }),
  async (req, res) => {
    res.json(await auth.resetPassword(validated(req, resetPasswordBody)))
  },
)
