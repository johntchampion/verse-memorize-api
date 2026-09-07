import { Router } from 'express'
import * as queue from '../controllers/queueController'
import { validate, validated } from '../lib/http'
import { resolveTranslation } from '../middleware/translation'
import {
  nextVerseBody,
  queueOrderBody,
  slotReplaceBody,
  themeBody,
} from '../schemas'

export const queueRouter = Router()

// Every route here serves verse text, so all of them need a resolved
// translation and all of them 400 on an unknown one.
queueRouter.use(resolveTranslation)

queueRouter.get('/queue', (req, res) => {
  res.json(queue.show(req))
})

queueRouter.put('/queue', validate(queueOrderBody), (req, res) => {
  res.json(queue.replaceOrder(req, validated(req, queueOrderBody)))
})

queueRouter.delete('/queue', (req, res) => {
  res.json(queue.resetOrder(req))
})

queueRouter.post('/queue/theme', validate(themeBody), (req, res) => {
  res.json(queue.moveTheme(req, validated(req, themeBody)))
})

queueRouter.post('/queue/next', validate(nextVerseBody), (req, res) => {
  res.json(queue.moveNext(req, validated(req, nextVerseBody)))
})

queueRouter.post('/slots/replace', validate(slotReplaceBody), (req, res) => {
  res.json(queue.replaceSlot(req, validated(req, slotReplaceBody)))
})
