import type { NextFunction, Request, Response } from 'express'
import { z } from 'zod'
import { ValidationError } from './errors'

export interface ValidateOptions {
  /** Omit `details` from the 400. Login uses this: it must not say which field was wrong. */
  terse?: boolean
}

/**
 * Validates the request body against a schema before the handler runs, and
 * replaces `req.body` with the parsed value — so unknown keys are stripped by
 * the time anything reads it.
 */
export function validate<T extends z.ZodType>(
  schema: T,
  options: ValidateOptions = {},
) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      throw new ValidationError(
        options.terse ? undefined : z.treeifyError(parsed.error),
      )
    }
    req.body = parsed.data
    next()
  }
}

/** Reads the body a matching `validate(schema)` already parsed. */
export function validated<T extends z.ZodType>(
  req: Request,
  _schema: T,
): z.infer<T> {
  return req.body as z.infer<T>
}
