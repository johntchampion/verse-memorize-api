import express, { type NextFunction, type Request, type Response } from 'express';
import { requireAuth } from './middleware/auth';
import { authRouter } from './routes/auth';
import { meRouter } from './routes/me';
import { sessionRouter } from './routes/session';
import { versesRouter } from './routes/verses';

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use('/auth', authRouter);

  // JWT middleware guards every /api/* route.
  app.use('/api', requireAuth, sessionRouter);
  app.use('/api', requireAuth, versesRouter);
  app.use('/api', requireAuth, meRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
