/** Returns a float in [0, 1), like Math.random but seeded and reproducible. */
export type Random = () => number

/** mulberry32 — small deterministic PRNG so a given seed rebuilds the same exercise. */
export function seededRandom(seed: string): Random {
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

export function shuffle<T>(items: T[], random: Random): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
