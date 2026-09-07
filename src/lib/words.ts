/** The exercise builder and the bank validator must agree on what "a word" is:
    the validator rejects a decoy already in its own verse, which only means
    anything if it splits text the way the tiles do. */
/** The word inside a whitespace-delimited token — letters, digits, apostrophes, hyphens. */
export const WORD_PATTERN = /[\p{L}\p{N}'’-]+/u

export function coreWord(raw: string): string {
  return WORD_PATTERN.exec(raw)?.[0].toLowerCase() ?? ''
}

export function wordsIn(text: string): Set<string> {
  return new Set(text.split(/\s+/).map(coreWord).filter(Boolean))
}
