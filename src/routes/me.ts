import { Router } from 'express'
import * as me from '../controllers/meController'
import { validate, validated } from '../lib/http'
import { deleteAccountBody, profilePatch } from '../schemas'

export const meRouter = Router()

meRouter.get('/me', (req, res) => {
  res.json(me.show(req))
})

meRouter.patch('/me', validate(profilePatch), (req, res) => {
  res.json(me.update(req, validated(req, profilePatch)))
})

// POST rather than DELETE because it needs a body to re-confirm the password
// before an irreversible action, and a DELETE body is the sort of thing
// intermediaries feel free to drop.
meRouter.post(
  '/me/delete-account',
  validate(deleteAccountBody),
  async (req, res) => {
    res.json(await me.deleteAccount(req, validated(req, deleteAccountBody)))
  },
)
