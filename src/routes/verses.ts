import { Router } from 'express'
import * as verses from '../controllers/versesController'
import { resolveTranslation } from '../middleware/translation'

export const versesRouter = Router()

// Both routes serve verse text, so both need a resolved translation.
versesRouter.use(resolveTranslation)

versesRouter.get('/verses', (req, res) => {
  res.json(verses.index(req))
})

versesRouter.get('/verses/:id', (req, res) => {
  res.json(verses.show(req))
})
