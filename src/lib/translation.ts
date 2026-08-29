import type { Request } from 'express';
import { normalizeTranslation, resolveTranslation } from '../data/verses';

/**
 * Which translation a read request should be served in: `?translation=` when
 * present, otherwise the account preference.
 *
 * The override is a preview mechanism — it never writes back to the account,
 * so a client can show a verse in another translation without committing the
 * user to it. Returns undefined for an override naming a translation that does
 * not exist, which callers turn into a 400; an unrecognised *stored* value is
 * not the caller's fault and quietly falls back to the default instead.
 */
export function translationFor(req: Request, stored: string | null | undefined): string | undefined {
  const override = req.query.translation;
  if (override === undefined) return resolveTranslation(stored);
  if (typeof override !== 'string') return undefined;
  return normalizeTranslation(override);
}
