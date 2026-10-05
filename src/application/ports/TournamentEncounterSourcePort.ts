import type { TournamentEncounter } from '../../domain/entities/TournamentEncounter'

/**
 * Puerto de "fuente de justas": de donde sale la identidad de cada justa de un
 * torneo (justa, ronda/arbol, equipos y heroes, y la sala de Combat vinculada
 * si ya existe).
 *
 * HU-83 (Management#465) depende formalmente de HU-78 (Management#469, genera
 * el bracket) y de HU-85 (Management#470/#485/#486, vincula cada justa con una
 * sala de Combat real). NINGUNA de las dos existe todavia en codigo. Este
 * puerto es el punto de reemplazo exacto: el dia que HU-78 exista, el
 * adaptador real implementa este mismo contrato leyendo el bracket generado en
 * lugar de devolver datos fijos.
 *
 * Hoy solo lo satisface `DevFixtureTournamentEncounterSource`, un doble
 * explicito de desarrollo: NO es el bracket real, documentado como tal en su
 * propio nombre de fichero y clase.
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
