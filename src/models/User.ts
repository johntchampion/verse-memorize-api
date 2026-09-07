import bcrypt from 'bcrypt'
import type { UserRow } from '../db/rows'
import { resolveTranslation } from '../data/verses'
import { todayInTimezone } from '../lib/dates'

export class User {
  readonly id: string
  readonly email: string
  readonly timezone: string
  readonly remindersEnabled: boolean
  readonly createdAt: string
  readonly reminderLastSentDate: string | null
  private readonly passwordHash: string
  /** What the account is stored as, before the catalog has vetted it. */
  private readonly storedTranslation: string

  constructor(row: UserRow) {
    this.id = row.id
    this.email = row.email
    this.timezone = row.timezone
    this.remindersEnabled = row.reminders_enabled === 1
    this.createdAt = row.created_at
    this.reminderLastSentDate = row.reminder_last_sent_date
    this.passwordHash = row.password_hash
    this.storedTranslation = row.translation
  }

  /**
   * A code the bank actually has. A translation since removed from the catalog
   * falls back to the default rather than erroring on every request.
   */
  get translation(): string {
    return resolveTranslation(this.storedTranslation)
  }

  /** The user's local date now — the boundary every streak and due date uses. */
  today(): string {
    return todayInTimezone(this.timezone)
  }

  localDate(instant: Date): string {
    return todayInTimezone(this.timezone, instant)
  }

  verifyPassword(plain: string): Promise<boolean> {
    return bcrypt.compare(plain, this.passwordHash)
  }
}
