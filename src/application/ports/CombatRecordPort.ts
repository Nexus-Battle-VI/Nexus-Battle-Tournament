/**
 * Puerto de lectura del registro autoritativo de una sala de Combat.
 *
 * `HttpCombatRecordAdapter` traduce el contrato publicado de
 * `GET /api/internal/v1/combat/tournament-rooms/{roomId}/record?afterSeq=N`,
 * con eventos anidados y equipos del motor, a este puerto histórico de HU-83.
 * Las consultas solo leen salas previamente vinculadas; la creación y el
 * inicio pertenecen a HU-85. `teams` es opcional para conservar los dobles
 * históricos, que las pruebas seleccionan explícitamente.
 */

/**
 * Estado de la SALA en Combat, no el de la justa en Tournament. Vease el
 * comentario en `domain/entities/TournamentEncounter.ts` sobre por que se
 * duplica ese vocabulario en el dominio en lugar de importarlo desde aqui.
 */
export const CombatRoomStatus = {
  Preparing: 'PREPARING',
  InBattle: 'IN_BATTLE',
  Finished: 'FINISHED',
} as const

export type CombatRoomStatus = (typeof CombatRoomStatus)[keyof typeof CombatRoomStatus]

export interface CombatRoomResultWire {
  readonly winnerTeamLabel: string | null
  readonly reason: string
  readonly outcome: string
  readonly finishedAt: Date
}

export interface CombatRoomEventWire {
  readonly roomId: string
  readonly seq: number
  readonly type: string
  readonly occurredAt: Date
  readonly payload: unknown
}

export interface CombatRoomRecord {
  readonly teams?: readonly {
    teamLabel: string
    participants: readonly { playerId: string; heroId: string }[]
  }[]
  readonly roomId: string
  /**
   * Eco de la identidad de la justa que pidio la lectura. Comprobarlo contra
   * lo que el llamador esperaba es lo que impide, del lado de Tournament, que
   * un adaptador real mal configurado mezcle el registro de una justa con el
   * de otra (CA-01 de HU-83: "los registros y resultados de encuentros
   * simultaneos no se mezclan").
   */
  readonly tournamentId: string
  readonly encounterId: string
  readonly status: CombatRoomStatus
  readonly startedAt: Date | null
  readonly result: CombatRoomResultWire | null
  /** Eco del `afterSeq` solicitado. */
  readonly afterSeq: number
  /** Ultima secuencia que Combat conoce para esta sala, se haya devuelto o no. */
  readonly lastSeq: number
  /** Hasta 100 eventos, en orden, a partir de `afterSeq + 1`. */
  readonly events: readonly CombatRoomEventWire[]
}

export interface CombatRecordPort {
  readRecord(roomId: string, afterSeq: number): Promise<CombatRoomRecord>
}

export const COMBAT_RECORD = Symbol('CombatRecordPort')
