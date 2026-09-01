/**
 * Thematic groupings over the verse bank. Application data like the bank
 * itself: defined in code, never written to the database, and validated at
 * module load so a bad edit takes the server down at startup.
 *
 * Themes exist so a user can pull a whole topic to the front of their practice
 * queue at once; nothing in the progression model depends on them. They are
 * curated by content, not by curriculum position: a verse may appear in more
 * than one theme (Titus 3:5 is both grace and new birth), and a verse may
 * appear in none. A theme's verseIds are its own reading order — that is the
 * order they take when the theme is moved to the top of the queue.
 */
import { versesInOrder } from './verses'

export interface Theme {
  id: string
  name: string
  verseIds: string[]
}

export const THEMES: Theme[] = [
  {
    id: 'nature-of-god',
    name: 'The Nature of God',
    verseIds: [
      'gen-1-1',
      'exod-3-14-15',
      'deut-6-4-5',
      'isa-46-9-10',
      'ps-90-2',
      'mal-3-6',
      '1john-4-8',
      'ps-139-7-10',
    ],
  },
  {
    id: 'trinity',
    name: 'The Trinity',
    verseIds: ['matt-28-19', '2cor-13-14', 'john-14-16-17', 'gen-1-26'],
  },
  {
    id: 'deity-of-christ',
    name: 'The Deity of Christ',
    verseIds: [
      'john-1-1-3',
      'john-8-58',
      'col-2-9',
      'heb-1-3',
      'phil-2-6-7',
      'rev-1-17-18',
      'john-20-28',
      'isa-9-6',
    ],
  },
  {
    id: 'humanity-of-christ',
    name: 'The Humanity of Christ',
    verseIds: ['john-1-14', 'heb-2-17', 'heb-4-15'],
  },
  {
    id: 'scripture',
    name: 'Scripture and Revelation',
    verseIds: ['2tim-3-16-17', '2pet-1-20-21', 'ps-119-105', 'heb-4-12'],
  },
  {
    id: 'sinfulness-of-man',
    name: 'The Sinfulness of Man',
    verseIds: [
      'rom-3-23',
      'rom-3-10-12',
      'isa-64-6',
      'jer-17-9',
      'gen-3-6-7',
      'rom-5-12',
    ],
  },
  {
    id: 'salvation-by-grace',
    name: 'Salvation by Grace Through Faith',
    verseIds: [
      'eph-2-8-9',
      'rom-6-23',
      'john-3-16',
      'titus-3-5',
      'acts-16-31',
      'rom-10-9-10',
    ],
  },
  {
    id: 'justification',
    name: 'Justification',
    verseIds: ['rom-5-1', 'rom-4-4-5', '2cor-5-21', 'gal-2-16'],
  },
  {
    id: 'atonement',
    name: 'The Atonement',
    verseIds: ['1pet-2-24', 'isa-53-5-6', 'rom-5-8', 'heb-9-22', '1john-2-2'],
  },
  {
    id: 'resurrection',
    name: 'The Resurrection',
    verseIds: ['1cor-15-3-4', '1cor-15-17', 'rom-4-25', 'rom-1-4'],
  },
  {
    id: 'exclusivity-of-christ',
    name: 'The Exclusivity of Christ',
    verseIds: ['john-14-6', 'acts-4-12', '1tim-2-5-6'],
  },
  {
    id: 'repentance-and-faith',
    name: 'Repentance and Faith',
    verseIds: ['mark-1-15', 'acts-2-38', 'acts-17-30', 'luke-13-3'],
  },
  {
    id: 'regeneration',
    name: 'Regeneration / New Birth',
    verseIds: ['john-3-3', '2cor-5-17', 'titus-3-5', 'ezek-36-26-27'],
  },
  {
    id: 'holy-spirit',
    name: 'The Holy Spirit',
    verseIds: ['john-16-13', 'rom-8-9', '1cor-3-16', 'gal-5-22-23'],
  },
  {
    id: 'sanctification',
    name: 'Sanctification',
    verseIds: ['1thess-4-3', 'phil-2-12-13', 'rom-8-29', 'john-17-17'],
  },
  {
    id: 'assurance',
    name: 'Assurance of Salvation',
    verseIds: ['john-10-27-29', 'rom-8-38-39', '1john-5-13', 'phil-1-6'],
  },
  {
    id: 'church',
    name: 'The Church',
    verseIds: ['matt-16-18', 'eph-1-22-23', 'acts-2-42', 'heb-10-24-25'],
  },
  {
    id: 'baptism-and-lords-supper',
    name: "Baptism and the Lord's Supper",
    verseIds: ['matt-28-19-20', '1cor-11-23-26', 'rom-6-3-4'],
  },
  {
    id: 'prayer',
    name: 'Prayer',
    verseIds: ['phil-4-6-7', 'matt-6-9-13', '1thess-5-17'],
  },
  {
    id: 'second-coming',
    name: 'The Second Coming',
    verseIds: ['john-14-3', 'acts-1-11', '1thess-4-16-17', 'rev-22-20'],
  },
  {
    id: 'judgment-and-hell',
    name: 'Judgment and Hell',
    verseIds: ['heb-9-27', 'rev-20-11-15', 'matt-25-46', '2thess-1-8-9'],
  },
  {
    id: 'heaven-and-eternal-life',
    name: 'Heaven and Eternal Life',
    verseIds: ['rev-21-3-4', 'john-17-3', '1cor-2-9'],
  },
  {
    id: 'christian-life',
    name: 'The Christian Life',
    verseIds: ['matt-22-37-39', 'rom-12-1-2', 'gal-2-20', 'mic-6-8'],
  },
]

const themesByVerseId = new Map<string, Theme[]>()

export function getTheme(id: string): Theme | undefined {
  return THEMES.find((t) => t.id === id)
}

/** Every theme a verse belongs to — possibly several, possibly none. */
export function themesForVerse(verseId: string): Theme[] {
  return themesByVerseId.get(verseId) ?? []
}

/**
 * Every listed verse id must exist in the bank, with no duplicates inside a
 * single theme and no duplicate theme ids. Cross-theme repeats are fine, and a
 * bank verse absent from every theme is fine — it just doesn't jump with one.
 */
function validateThemes(): void {
  const bankIds = new Set(versesInOrder().map((v) => v.id))
  const themeIds = new Set<string>()

  for (const theme of THEMES) {
    if (themeIds.has(theme.id)) {
      throw new Error(`duplicate theme id "${theme.id}"`)
    }
    themeIds.add(theme.id)

    const seen = new Set<string>()
    for (const verseId of theme.verseIds) {
      if (!bankIds.has(verseId)) {
        throw new Error(`theme ${theme.id}: unknown verse id "${verseId}"`)
      }
      if (seen.has(verseId)) {
        throw new Error(`theme ${theme.id}: verse "${verseId}" listed twice`)
      }
      seen.add(verseId)
      const list = themesByVerseId.get(verseId)
      if (list) list.push(theme)
      else themesByVerseId.set(verseId, [theme])
    }
  }
}

validateThemes()
