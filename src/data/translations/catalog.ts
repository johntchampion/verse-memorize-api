/**
 * The translation registry. Adding a translation is two steps: drop a JSON file
 * in this directory and add an entry below. Everything else — the loader, the
 * validator, `GET /api/translations`, and the `?translation=` override — reads
 * from this list.
 *
 * `code` is stored verbatim in `users.translation`, so it must never change
 * once users have selected it. Removing an entry is safe: accounts pointing at
 * a code that is no longer here fall back to `DEFAULT_TRANSLATION` rather than
 * erroring (see `resolveTranslation` in ../verses.ts).
 */
export interface TranslationMeta {
  /** Stable uppercase identifier, e.g. 'WEB'. Stored on the user row. */
  code: string
  name: string
  /** Filename within this directory. */
  file: string
  license: string
}

/**
 * The translation every other one is checked against. Its file defines the
 * bank: which verses exist, their `order`, their `reference`, and the canonical
 * Bible ordering (the array's own layout).
 */
export const REFERENCE_TRANSLATION = 'WEB'

/** Served to any user who has not chosen otherwise. */
export const DEFAULT_TRANSLATION = 'WEB'

export const TRANSLATIONS: TranslationMeta[] = [
  {
    code: 'WEB',
    name: 'World English Bible',
    file: 'web.json',
    license: 'Public domain',
  },
  {
    code: 'KJV',
    name: 'King James Version',
    file: 'kjv.json',
    license: 'Public domain in the US; Crown copyright in the UK',
  },
]
