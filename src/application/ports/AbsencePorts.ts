import type { AbsenceResolution, ReadinessRecord } from '../../domain/absence'

/** Aceptaciones de combate y resoluciones por ausencia (decisiones sobre HU-85). */
export interface AbsenceStore {
  /** Idempotente: un jugador acepta una sola vez; repetir conserva la primera hora. */
  accept(record: ReadinessRecord): Promise<void>
  listReady(tournamentId: string, encounterId: string): Promise<readonly ReadinessRecord[]>
  findResolution(tournamentId: string, encounterId: string): Promise<AbsenceResolution | null>
  /** Guarda la resolución si no existe; si ya existía devuelve la existente (nunca dos). */
  saveResolution(resolution: AbsenceResolution): Promise<AbsenceResolution>
}

export const ABSENCE_STORE = Symbol('AbsenceStore')
