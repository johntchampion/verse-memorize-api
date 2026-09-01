import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express'
import { ApiError } from './lib/errors'
import { requireAuth } from './middleware/auth'
import { authRouter } from './routes/auth'
import { meRouter } from './routes/me'
import { queueRouter } from './routes/queue'
import { sessionRouter } from './routes/session'
import { translationsRouter } from './routes/translations'
import { versesRouter } from './routes/verses'

export function createApp() {
  const app = express()
  app.use(express.json())

  app.get('/health', (_req, res) => res.json({ ok: true }))

  app.use('/auth', authRouter)

  app.use('/api', requireAuth, sessionRouter)
  app.use('/api', requireAuth, versesRouter)
  app.use('/api', requireAuth, queueRouter)
  app.use('/api', requireAuth, meRouter)
  app.use('/api', requireAuth, translationsRouter)

  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' })
  })

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // Express 5 routes both sync throws and rejected promises here, so a
    // service can signal a client error by throwing from anywhere and the
    // routes need no try/catch of their own.
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: err.message })
      return
    }
    console.error(err)
    res.status(500).json({ error: 'internal error' })
  })

  return app
}
