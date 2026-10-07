import type { TournamentEncounter } from '../../domain/entities/TournamentEncounter'

/**
 * Puerto de "fuente de justas": de donde sale la identidad de cada justa de un
 * torneo (justa, ronda/arbol, equipos y heroes, y la sala de Combat vinculada
 * si ya existe).
 *
 * `PersistedBracketEncounterSource` lee el snapshot publicado por HU-78.
 * Los equipos de inscripción conocidos van en `bracketMetadata`; el roster
 * de héroes y la sala solo aparecen cuando exista la integración HU-85.
 * `DevFixtureTournamentEncounterSource` permanece como doble explícito de
 * regresión y no se selecciona en la composición de la aplicación.
 */
export interface TournamentEncounterSourcePort {
  /**
   * Justas conocidas de un torneo, en el estado que el bracket ya resolvio.
   *
   * Devuelve la justa tal como la conoce el bracket: equipos/heroes cuando ya
   * estan resueltos (ronda alcanzada), vacios cuando todavia no (ronda
   * futura, `WAITING_PARTICIPANTS`), y el `combatRoomId` si HU-85 ya vinculo
   * una sala. El estado fino de la sala (en curso, resultado) NO sale de aqui:
   * eso lo informa `CombatRecordPort`, que es quien tiene autoridad sobre ello.
   */
  listEncounters(tournamentId: string): Promise<readonly TournamentEncounter[]>
}

export const TOURNAMENT_ENCOUNTER_SOURCE = Symbol('TournamentEncounterSourcePort')
