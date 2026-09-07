import type { SessionEventRow } from '../db/rows'
import { getVerse } from '../data/verses'
import type { SessionEventKind } from '../domain/sessionEvent'
import type { Stage } from '../domain/stage'

export interface SessionEventBody {
  id: string
  kind: SessionEventKind
  verseId: string
  reference: string
  stageFrom: Stage | null
  stageTo: Stage | null
  slot: number | null
  createdAt: string
}

/**
 * Something the day moved, as the completion screen needs it.
 *
 * The stored row keeps only the verse slug, because a slug is what stays true
 * across a translation change; the human reference is rendered here, from the
 * bank the reader is currently on.
 */
export class SessionEvent {
  constructor(private readonly row: SessionEventRow) {}

  static fromRows(rows: SessionEventRow[]): SessionEvent[] {
    return rows.map((row) => new SessionEvent(row))
  }

  /** Null when the verse has left the bank — dropped rather than served referenceless. */
  toBody(translation: string): SessionEventBody | null {
    const verse = getVerse(this.row.verse_id, translation)
    if (!verse) return null

    return {
      id: this.row.id,
      kind: this.row.kind,
      verseId: this.row.verse_id,
      reference: verse.reference,
      stageFrom: this.row.stage_from,
      stageTo: this.row.stage_to,
      slot: this.row.slot,
      createdAt: this.row.created_at,
    }
  }

  static bodies(
    rows: SessionEventRow[],
    translation: string,
  ): SessionEventBody[] {
    return SessionEvent.fromRows(rows)
      .map((event) => event.toBody(translation))
      .filter((body) => body !== null)
  }
}
