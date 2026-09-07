import type { SessionEventBody } from '../models/SessionEvent'
import type { SessionExercise } from '../models/SessionExercise'

export interface SessionViewInput {
  translation: string
  practice: boolean
  exercises: SessionExercise[]
  events: SessionEventBody[]
}

export function sessionView({
  translation,
  practice,
  exercises,
  events,
}: SessionViewInput) {
  return {
    translation,
    practice,
    exercises,
    count: exercises.length,
    completedCount: exercises.filter((exercise) => exercise.completed).length,
    // Trues rather than "not falses": an exercise answered before correctness
    // was recorded is null, and guessing at it would inflate the tally.
    correctCount: exercises.filter((exercise) => exercise.correct === true)
      .length,
    events,
  }
}
