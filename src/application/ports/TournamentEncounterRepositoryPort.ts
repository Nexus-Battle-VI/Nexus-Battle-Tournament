import type { CombatEventPage, CombatEventRecord } from '../../domain/entities/CombatEventRecord'
import type { TournamentEncounter } from '../../domain/entities/TournamentEncounter'

/**
 * Puerto de persistencia propia de Tournament para las justas y su proyeccion
 * de eventos de Combat. Dos implementaciones: `InMemoryTournamentEncounterRepository`
 * (pruebas y `PERSISTENCE_DRIVER=memory`) y `PostgresTournamentEncounterRepository`
 * (`PERSISTENCE_DRIVER=postgres`), sobre las tablas `tournament_encounters` y
 * `tournament_combat_events`.
 */
export interface TournamentEncounterRepositoryPort {
  findLinked?(): Promise<readonly TournamentEncounter[]>
  findAllByTournament(tournamentId: string): Promise<readonly TournamentEncounter[]>

  findOne(tournamentId: string, encounterId: string): Promise<TournamentEncounter | null>

  /** Crea o reemplaza la justa completa. Upsert por `(tournamentId, encounterId)`. */
  save(encounter: TournamentEncounter): Promise<void>

  /**
   * Anade eventos a la proyeccion de solo-anadir. IDEMPOTENTE: un evento cuyo
   * `(tournamentId, encounterId, seq)` ya existe se descarta en silencio, sin
   * duplicarlo ni sobrescribirlo. Es lo que sostiene CA-03 (reenviar el cierre
   * no duplica el registro) a nivel de persistencia, no solo de dominio.
   */
  appendEvents(events: readonly CombatEventRecord[]): Promise<void>

  /**
   * Pagina de hasta `limit` eventos ya proyectados, ordenados por `seq`
   * ascendente, a partir de `afterSeq + 1`.
   */
  listEvents(
    tournamentId: string,
    encounterId: string,
    afterSeq: number,
    limit: number,
  ): Promise<CombatEventPage>
}

export const TOURNAMENT_ENCOUNTER_REPOSITORY = Symbol('TournamentEncounterRepositoryPort')
