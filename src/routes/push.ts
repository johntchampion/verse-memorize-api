import { Router } from 'express'
import * as push from '../controllers/pushController'
import { validate, validated } from '../lib/http'
import { subscribeBody, unsubscribeBody } from '../schemas'

export const pushRouter = Router()

pushRouter.get('/push/key', (_req, res) => {
  res.json(push.key())
})

pushRouter.post('/push/subscribe', validate(subscribeBody), (req, res) => {
  res.status(201).json(push.subscribe(req, validated(req, subscribeBody)))
})

// POST rather than DELETE because it needs a body to say which device.
pushRouter.post('/push/unsubscribe', validate(unsubscribeBody), (req, res) => {
  res.json(push.unsubscribe(req, validated(req, unsubscribeBody)))
})

pushRouter.post('/push/test', async (req, res) => {
  res.json(await push.test(req))
})
