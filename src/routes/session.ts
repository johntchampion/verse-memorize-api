import { Router } from 'express'
import * as session from '../controllers/sessionController'
import { validate, validated } from '../lib/http'
import { resolveTranslation } from '../middleware/translation'
import { attemptBody } from '../schemas'

export const sessionRouter = Router()

// Every route here serves verse text, so all of them need a resolved translation.
sessionRouter.use(resolveTranslation)

sessionRouter.get('/session/today', (req, res) => {
  res.json(session.today(req))
})

sessionRouter.post('/attempt', validate(attemptBody), (req, res) => {
  res.json(session.attempt(req, validated(req, attemptBody)))
})

sessionRouter.post('/session/complete', (req, res) => {
  res.json(session.complete(req))
})
