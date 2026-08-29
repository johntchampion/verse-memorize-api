import type { ExerciseType, Stage } from '../db/client'
import type { Verse } from '../data/verses'

/**
 * Blank density and word-choice mode per stage.
 *
 * `density` is the fraction of words blanked; tiles vs. typing follows the
 * same table.
 */
const STAGE_RULES: Record<Stage, { density: number; type: ExerciseType }> = {
  learning_light: { density: 0.18, type: 'tile_fill_blank' },
  learning_medium: { density: 0.5, type: 'tile_fill_blank' },
  learning_heavy: { density: 0.8, type: 'tile_fill_blank' },
  review: { density: 1, type: 'tile_fill_blank' },
  mastered: { density: 1, type: 'type_fill_blank' },
}

/**
 * Connectors, deprioritised for blanking at low density so that early tiers
 * blank content words instead. No NLP — the bank is small and
 * hardcoded, so a stopword list is enough.
 */
const CONNECTORS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'have',
  'has',
  'he',
  'her',
  'him',
  'his',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'not',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'them',
  'they',
  'this',
  'to',
  'up',
  'us',
  'was',
  'we',
  'were',
  'will',
  'with',
  'you',
  'your',
])

const BLANK = '____'

interface Token {
  /** The whitespace-delimited token, punctuation included. */
  raw: string
  /** Letters only, lowercased — used for connector lookup and the word bank. */
  core: string
  /** Offsets of `core` within `raw`, so punctuation survives blanking. */
  start: number
  end: number
}

function tokenize(text: string): Token[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => {
      const match = /[\p{L}\p{N}'’-]+/u.exec(raw)
      if (!match) return { raw, core: '', start: 0, end: 0 }
      return {
        raw,
        core: match[0].toLowerCase(),
        start: match.index,
        end: match.index + match[0].length,
      }
    })
}

/** mulberry32 — small deterministic PRNG so a given seed rebuilds the same exercise. */
function rng(seed: string): () => number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  }
  let a = h >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(items: T[], next: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Picks which token indexes to blank.
 *
 * Content words are drawn before connectors, so a light-density exercise blanks
 * meaning-bearing words and a heavy one ends up blanking nearly everything
 * regardless. At density 1 every word goes; below that at least one anchor word
 * is always left visible.
 */
function chooseBlanks(
  tokens: Token[],
  density: number,
  next: () => number,
): Set<number> {
  const eligible = tokens
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.core.length > 0)
  if (eligible.length === 0) return new Set()

  if (density >= 1) return new Set(eligible.map(({ i }) => i))

  const target = Math.min(
    Math.max(1, Math.round(density * eligible.length)),
    eligible.length - 1,
  )

  const content = shuffle(
    eligible.filter(({ t }) => !CONNECTORS.has(t.core)),
    next,
  )
  const connectors = shuffle(
    eligible.filter(({ t }) => CONNECTORS.has(t.core)),
    next,
  )

  return new Set([...content, ...connectors].slice(0, target).map(({ i }) => i))
}

export interface Exercise {
  verseId: string
  /** The client posts this back as the key for POST /api/attempt. */
  userVerseId: string
  exerciseType: ExerciseType
  reference: string
  blankedText: string
  /** Empty for typed exercises — there are no tiles to show. */
  wordBank: string[]
}

/**
 * Builds one exercise instance.
 *
 * `instance` distinguishes the 2-3 repetitions of the same verse within a
 * session: it feeds the seed, so the repetitions blank different words but any
 * given one is reproducible.
 */
export function buildExercise(
  verse: Verse,
  userVerseId: string,
  stage: Stage,
  instance = 0,
): Exercise {
  const rule = STAGE_RULES[stage]
  const tokens = tokenize(verse.text)
  const next = rng(`${verse.id}:${stage}:${instance}`)
  const blanks = chooseBlanks(tokens, rule.density, next)

  const blankedText = tokens
    .map((token, i) => {
      if (!blanks.has(i)) return token.raw
      return (
        token.raw.slice(0, token.start) + BLANK + token.raw.slice(token.end)
      )
    })
    .join(' ')

  let wordBank: string[] = []
  if (rule.type === 'tile_fill_blank') {
    const answers = [...blanks]
      .sort((a, b) => a - b)
      .map((i) => {
        const token = tokens[i]
        return token.raw.slice(token.start, token.end)
      })
    // A sample of the verse's own decoys, mixed in with the correct words and
    // scaled to the number of blanks so light exercises aren't swamped by
    // wrong tiles.
    const decoyCount = Math.min(
      verse.decoys.length,
      Math.max(3, Math.ceil(answers.length / 2)),
    )
    const decoys = shuffle(verse.decoys, next).slice(0, decoyCount)
    wordBank = shuffle([...answers, ...decoys], next)
  }

  return {
    verseId: verse.id,
    userVerseId,
    exerciseType: rule.type,
    reference: verse.reference,
    blankedText,
    wordBank,
  }
}

/** The exercise type a given stage is drilled with. */
export function exerciseTypeForStage(stage: Stage): ExerciseType {
  return STAGE_RULES[stage].type
}
