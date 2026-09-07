/**
 * The verse bank, loaded from src/data/translations/*.json at startup and never
 * written to the database. REFERENCE_TRANSLATION defines it; every other file
 * must agree exactly, and validateBank throws during module load if one
 * doesn't — taking the server down rather than serving a half-translated
 * session. See the README for the invariants each file has to hold.
 */
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { coreWord, wordsIn } from '../lib/words'
import {
  DEFAULT_TRANSLATION,
  REFERENCE_TRANSLATION,
  TRANSLATIONS,
  type TranslationMeta,
} from './translations/catalog'

export interface Verse {
  id: string
  reference: string
  text: string
  order: number
  decoys: string[]
}

const verseSchema = z.object({
  id: z.string().min(1),
  reference: z.string().min(1),
  text: z.string().min(1),
  order: z.number().int().positive(),
  decoys: z.array(z.string().min(1)).min(1),
})

const fileSchema = z.array(verseSchema).min(1)

interface Bank {
  meta: TranslationMeta
  byId: Map<string, Verse>
  /** Curriculum sequence — `order` ascending. */
  inOrder: Verse[]
  /** Canonical Bible order, taken from the reference translation's layout. */
  inCanonOrder: Verse[]
}

function loadFile(meta: TranslationMeta): Verse[] {
  // Relative to this module, so it works from both src/ (tsx) and dist/.
  const file = path.join(__dirname, 'translations', meta.file)

  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(
      `translation ${meta.code}: cannot read ${meta.file} — ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const parsed = fileSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(
      `translation ${meta.code}: ${meta.file} is malformed — ${JSON.stringify(z.treeifyError(parsed.error))}`,
    )
  }
  return parsed.data
}

function summarize(ids: string[]): string {
  return ids.length > 10
    ? `${ids.slice(0, 10).join(', ')} (+${ids.length - 10} more)`
    : ids.join(', ')
}

function checkFile(verses: Verse[]): string[] {
  const problems: string[] = []

  const duplicates = [
    ...new Set(
      verses.map((v) => v.id).filter((id, i, all) => all.indexOf(id) !== i),
    ),
  ]
  if (duplicates.length)
    problems.push(`duplicate ids: ${summarize(duplicates)}`)

  const orders = new Set(verses.map((v) => v.order))
  const contiguous =
    orders.size === verses.length &&
    Math.min(...orders) === 1 &&
    Math.max(...orders) === verses.length
  if (!contiguous) {
    problems.push(
      `order values must be 1..${verses.length}, unique and contiguous`,
    )
  }

  for (const verse of verses) {
    const words = wordsIn(verse.text)
    const overlap = verse.decoys.filter((decoy) => words.has(coreWord(decoy)))
    if (overlap.length) {
      problems.push(
        `${verse.id}: decoys already appear in the verse text: ${overlap.join(', ')}`,
      )
    }
  }

  return problems
}

/** Problems only visible by comparing a file with the reference translation. */
function checkAgainstReference(verses: Verse[], reference: Verse[]): string[] {
  const problems: string[] = []
  const referenceById = new Map(reference.map((v) => [v.id, v]))
  const ids = new Set(verses.map((v) => v.id))

  const missing = reference.filter((v) => !ids.has(v.id)).map((v) => v.id)
  if (missing.length) problems.push(`missing verses: ${summarize(missing)}`)

  const extra = verses.filter((v) => !referenceById.has(v.id)).map((v) => v.id)
  if (extra.length) problems.push(`unknown verses: ${summarize(extra)}`)

  for (const verse of verses) {
    const expected = referenceById.get(verse.id)
    if (!expected) continue
    if (verse.order !== expected.order) {
      problems.push(
        `${verse.id}: order ${verse.order} does not match ${REFERENCE_TRANSLATION}'s ${expected.order}`,
      )
    }
    if (verse.reference !== expected.reference) {
      problems.push(
        `${verse.id}: reference "${verse.reference}" does not match ${REFERENCE_TRANSLATION}'s "${expected.reference}"`,
      )
    }
  }

  return problems
}

function checkCatalog(): void {
  const codes = TRANSLATIONS.map((t) => t.code)
  const duplicates = [
    ...new Set(codes.filter((code, i) => codes.indexOf(code) !== i)),
  ]
  if (duplicates.length)
    throw new Error(
      `translation catalog: duplicate codes: ${duplicates.join(', ')}`,
    )

  const wrongCase = codes.filter((code) => code !== code.toUpperCase())
  if (wrongCase.length) {
    throw new Error(
      `translation catalog: codes must be uppercase: ${wrongCase.join(', ')}`,
    )
  }

  for (const required of [REFERENCE_TRANSLATION, DEFAULT_TRANSLATION]) {
    if (!codes.includes(required)) {
      throw new Error(
        `translation catalog: ${required} is referenced but not listed`,
      )
    }
  }
}

function loadBanks(): Map<string, Bank> {
  checkCatalog()

  const files = new Map(TRANSLATIONS.map((meta) => [meta.code, loadFile(meta)]))
  const reference = files.get(REFERENCE_TRANSLATION)!

  const problems: string[] = []
  for (const meta of TRANSLATIONS) {
    const verses = files.get(meta.code)!
    const found = [
      ...checkFile(verses),
      ...(meta.code === REFERENCE_TRANSLATION
        ? []
        : checkAgainstReference(verses, reference)),
    ]
    problems.push(
      ...found.map((problem) => `  ${meta.code} (${meta.file}): ${problem}`),
    )
  }

  if (problems.length) {
    throw new Error(`the verse bank is inconsistent:\n${problems.join('\n')}`)
  }

  const banks = new Map<string, Bank>()
  for (const meta of TRANSLATIONS) {
    const verses = files.get(meta.code)!
    const byId = new Map(verses.map((v) => [v.id, v]))
    banks.set(meta.code, {
      meta,
      byId,
      inOrder: [...verses].sort((a, b) => a.order - b.order),
      // Canon order lives in the reference file's layout; every translation
      // renders that same sequence in its own words.
      inCanonOrder: reference.map((v) => byId.get(v.id)!),
    })
  }
  return banks
}

const BANKS = loadBanks()

/** Falls back rather than throwing: a translation dropped from the catalog
    should degrade to the default, not 500 on every request. */
function bankFor(translation: string): Bank {
  return BANKS.get(translation) ?? BANKS.get(DEFAULT_TRANSLATION)!
}

export function getVerse(
  id: string,
  translation: string = DEFAULT_TRANSLATION,
): Verse | undefined {
  return bankFor(translation).byId.get(id)
}

export function versesInOrder(
  translation: string = DEFAULT_TRANSLATION,
): Verse[] {
  return [...bankFor(translation).inOrder]
}

export function versesInCanonOrder(
  translation: string = DEFAULT_TRANSLATION,
): Verse[] {
  return [...bankFor(translation).inCanonOrder]
}

export function listTranslations(): TranslationMeta[] {
  return [...TRANSLATIONS]
}

export function isTranslation(code: string): boolean {
  return BANKS.has(code.trim().toUpperCase())
}

export function normalizeTranslation(code: string): string | undefined {
  const upper = code.trim().toUpperCase()
  return BANKS.has(upper) ? upper : undefined
}

/** Anything unrecognised, including a translation since removed from the
    catalog, resolves to the default. */
export function resolveTranslation(stored: string | null | undefined): string {
  return (stored && normalizeTranslation(stored)) || DEFAULT_TRANSLATION
}

export { DEFAULT_TRANSLATION, type TranslationMeta }
