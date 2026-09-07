export interface TranslationMeta {
  /** Stable uppercase identifier, e.g. 'WEB'. Stored on the user row. */
  code: string
  name: string
  file: string
  license: string
}

/** Its file defines the bank: which verses exist, their order and reference,
    and the canonical Bible ordering. */
export const REFERENCE_TRANSLATION = 'WEB'

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
