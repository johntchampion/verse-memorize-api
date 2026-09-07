import type { AttemptRow } from '../db/rows'

/** `attempts` is the raw row shape: clients have always received it that way. */
export class AttemptHistory {
  constructor(readonly attempts: AttemptRow[]) {}

  get total(): number {
    return this.attempts.length
  }

  get correct(): number {
    return this.attempts.filter((attempt) => attempt.correct === 1).length
  }

  toBody() {
    return { attempts: this.attempts, total: this.total, correct: this.correct }
  }
}
