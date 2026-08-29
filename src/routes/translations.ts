import { Router } from 'express'
import { DEFAULT_TRANSLATION, listTranslations } from '../data/verses'

export const translationsRouter = Router()

/** The translations a user can pick between, for the settings picker. */
translationsRouter.get('/translations', (_req, res) => {
  res.json({
    translations: listTranslations().map(({ code, name, license }) => ({
      code,
      name,
      license,
    })),
    default: DEFAULT_TRANSLATION,
  })
})
