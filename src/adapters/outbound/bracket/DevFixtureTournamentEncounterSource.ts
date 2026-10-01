import {
  TournamentMatchStatus,
  type TournamentEncounter,
} from '../../../domain/entities/TournamentEncounter'
import type { TournamentEncounterSourcePort } from '../../../application/ports/TournamentEncounterSourcePort'

/**
 * ============================================================================
 *  FIXTURE DE DESARROLLO — NO ES EL BRACKET REAL.
 * ============================================================================
 *
 * Implementa `TournamentEncounterSourcePort` con cuatro justas fijas (E1-E4)
 * en lugar de leer el bracket que generaria HU-78 (Management#469, todavia sin
 * implementar) y de confiar en el vinculo de sala que crearia HU-85
 * (Management#470/#485/#486, tampoco implementada). Es el "primer incremento
 * acordado" que describen las tasks HU-83.1/HU-83.2 (Management#509/#510):
 * datos identificados y un adaptador intercambiable, no integracion real.
 *
 * E1: ronda 1, equipos resueltos, SIN sala de Combat vinculada todavia
 *     -> queda en `READY`.
 * E2: ronda 1, equipos resueltos, sala `room-e2` vinculada
 *     -> el stub de Combat la informa `IN_BATTLE`, sin resultado (CA-04).
 * E3: ronda 1, equipos resueltos, sala `room-e3` vinculada
 *     -> el stub de Combat la informa `FINISHED` con resultado (CA-03).
 * E4: ronda 2 (semifinal), equipos TODAVIA sin resolver
 *     -> `WAITING_PARTICIPANTS`, sin sala.
 *
 * Reemplazo previsto: un adaptador que implemente el mismo
 * `TournamentEncounterSourcePort` leyendo el agregado de bracket real que
 * produzca HU-78. Ningun caso de uso que consuma el puerto deberia cambiar.
 */
export class DevFixtureTournamentEncounterSource implements TournamentEncounterSourcePort {
  listEncounters(tournamentId: string): Promise<readonly TournamentEncounter[]> {
    const base: TournamentEncounter = {
      tournamentId,
      encounterId: 'E1',
      round: 1,
      bracketLabel: 'E1',
      teams: [],
      status: TournamentMatchStatus.Ready,
      combatRoomId: null,
      startedAt: null,
      closedAt: null,
      result: null,
      lastSyncedSeq: 0,
      logComplete: false,
    }

    const e1: TournamentEncounter = {
      ...base,
      encounterId: 'E1',
      bracketLabel: 'E1',
      teams: [
        {
          teamId: 'equipo-aurora',
          teamLabel: 'A',
          participants: [
            { playerId: 'jugador-1', heroId: 'heroe-fenix' },
            { playerId: 'jugador-2', heroId: 'heroe-roca' },
          ],
        },
        {
          teamId: 'equipo-nocturno',
          teamLabel: 'B',
          participants: [
            { playerId: 'jugador-3', heroId: 'heroe-sombra' },
            { playerId: 'jugador-4', heroId: 'heroe-tormenta' },
          ],
        },
      ],
      status: TournamentMatchStatus.Ready,
      combatRoomId: null,
    }

    const e2: TournamentEncounter = {
      ...base,
      encounterId: 'E2',
      bracketLabel: 'E2',
      teams: [
        {
          teamId: 'equipo-cenit',
          teamLabel: 'A',
          participants: [
            { playerId: 'jugador-5', heroId: 'heroe-glacial' },
            { playerId: 'jugador-6', heroId: 'heroe-vendaval' },
          ],
        },
        {
          teamId: 'equipo-eclipse',
          teamLabel: 'B',
          participants: [
            { playerId: 'jugador-7', heroId: 'heroe-brasa' },
            { playerId: 'jugador-8', heroId: 'heroe-marea' },
          ],
        },
      ],
      status: TournamentMatchStatus.Ready,
      combatRoomId: `room-${tournamentId}-E2`,
    }

    const e3: TournamentEncounter = {
      ...base,
      encounterId: 'E3',
      bracketLabel: 'E3',
      teams: [
        {
          teamId: 'equipo-titan',
          teamLabel: 'A',
          participants: [
            { playerId: 'jugador-9', heroId: 'heroe-coloso' },
            { playerId: 'jugador-10', heroId: 'heroe-rafaga' },
          ],
        },
        {
          teamId: 'equipo-fenix',
          teamLabel: 'B',
          participants: [
            { playerId: 'jugador-11', heroId: 'heroe-ceniza' },
            { playerId: 'jugador-12', heroId: 'heroe-abismo' },
          ],
        },
      ],
      status: TournamentMatchStatus.Ready,
      combatRoomId: `room-${tournamentId}-E3`,
    }

    const e4: TournamentEncounter = {
      ...base,
      encounterId: 'E4',
      round: 2,
      bracketLabel: 'E4',
      teams: [],
      status: TournamentMatchStatus.WaitingParticipants,
      combatRoomId: null,
    }

    return Promise.resolve([e1, e2, e3, e4])
  }
}
