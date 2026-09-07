import { DEFAULT_TRANSLATION } from '../data/verses'
import * as userVerses from '../repositories/userVerseRepository'
import { renderExercise, type SessionExercise } from './SessionExercise'

/** Big enough that two drills in a row are very unlikely to seed alike. */
const INSTANCE_RANGE = 1_000_000

/**
 * One exercise per slotted verse, outside the day's lesson: it neither reads nor
 * writes the day's plan, and it tracks the slots as they stand right now.
 */
export class PracticeDrill {
  constructor(private readonly userId: string) {}

  exercises(translation: string = DEFAULT_TRANSLATION): SessionExercise[] {
    const drill: SessionExercise[] = []

    for (const verse of userVerses.slottedForUser(this.userId)) {
      const exercise = renderExercise({
        verse,
        translation,
        stage: verse.stage,
        queue: 'learning',
        // Meant to be called repeatedly through the day, so this is the one
        // place the deterministic seed is given up on purpose: two drills in a
        // row must not blank the same words.
        instance: Math.floor(Math.random() * INSTANCE_RANGE),
        completed: false,
        correct: null,
      })
      if (exercise) drill.push(exercise)
    }

    return drill
  }
}
