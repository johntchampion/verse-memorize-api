/**
 * Word extraction shared by the exercise builder and the bank validator. Both
 * have to agree on what "a word" is: the validator rejects a decoy that already
 * appears in its own verse, and that check is only meaningful if it splits text
 * the same way the tiles do.
 */

/** The word inside a whitespace-delimited token — letters, digits, apostrophes, hyphens. */
export const WORD_PATTERN = /[\p{L}\p{N}'’-]+/u;

/** The lowercased word inside a raw token, or '' if it holds none. */
export function coreWord(raw: string): string {
  return WORD_PATTERN.exec(raw)?.[0].toLowerCase() ?? '';
}

/** Every distinct word in a passage, lowercased. */
export function wordsIn(text: string): Set<string> {
  return new Set(
    text
      .split(/\s+/)
      .map(coreWord)
      .filter(Boolean),
  );
}
