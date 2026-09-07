import type { ExerciseType } from '../db/rows'
import { CONNECTORS } from '../data/connectors'
import type { Verse } from '../data/verses'
import { STAGE_RULES, type Stage } from '../domain/stage'
import { seededRandom, shuffle, type Random } from '../lib/random'
import { WORD_PATTERN } from '../lib/words'

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
      const match = WORD_PATTERN.exec(raw)
      if (!match) return { raw, core: '', start: 0, end: 0 }
      return {
        raw,
        core: match[0].toLowerCase(),
        start: match.index,
        end: match.index + match[0].length,
      }
    })
}

/** Content words before connectors, so a light exercise blanks meaning-bearing
    words. At density 1 every word goes; below that one anchor stays visible. */
function chooseBlanks(
  tokens: Token[],
  density: number,
  random: Random,
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
    random,
  )
  const connectors = shuffle(
    eligible.filter(({ t }) => CONNECTORS.has(t.core)),
    random,
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
  const random = seededRandom(`${verse.id}:${stage}:${instance}`)
  const blanks = chooseBlanks(tokens, rule.density, random)

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
    const decoys = shuffle(verse.decoys, random).slice(0, decoyCount)
    wordBank = shuffle([...answers, ...decoys], random)
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
