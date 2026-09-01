/**
 * Request-handling helpers shared by the routes.
 */
import type { Request, Response } from 'express'
import { z } from 'zod'

/**
 * Validates a request body against a schema.
 *
 * Returns the parsed data, or null after sending a 400 — so a handler reads
 * `const body = parseBody(...); if (!body) return`. The 400 shape is the one
 * clients already receive: `{ error: 'invalid body', details }`.
 */
export function parseBody<T extends z.ZodType>(
  schema: T,
  req: Request,
  res: Response,
): z.infer<T> | null {
  const parsed = schema.safeParse(req.body)
  if (parsed.success) return parsed.data

  res
    .status(400)
    .json({ error: 'invalid body', details: z.treeifyError(parsed.error) })
  return null
}
