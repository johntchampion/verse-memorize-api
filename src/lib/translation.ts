import type { Request } from 'express'
import { normalizeTranslation, resolveTranslation } from '../data/verses'

/**
 * `?translation=` when present, otherwise the account preference. Undefined for
 * an override naming a translation that does not exist, which callers turn into
 * a 400; an unrecognised *stored* value is not the caller's fault and falls back
 * to the default instead.
 */
export function translationFor(
  req: Request,
  stored: string | null | undefined,
): string | undefined {
  const override = req.query.translation
  if (override === undefined) return resolveTranslation(stored)
  if (typeof override !== 'string') return undefined
  return normalizeTranslation(override)
}
