/**
 * Estado propio de una justa (`TournamentEncounter`), tal y como lo consulta un
 * participante. NO es el estado de la sala de Combat: ese vocabulario es de
 * Combat y llega a traves de `CombatRecordPort` (vease `CombatRoomStatus` ahi).
 * Esta es la proyeccion que Tournament decide mostrar a partir de lo que sabe
 * del bracket y de lo que Combat informa.
 */
import type { TeamAvatar } from '../registration'

export const TournamentMatchStatus = {
  /** El bracket todavia no resolvio los equipos de esta justa (ronda futura). */
  WaitingParticipants: 'WAITING_PARTICIPANTS',
  /** Equipos y heroes resueltos; la sala de Combat no se vinculo o no inicio. */
  Ready: 'READY',
  /** La sala de Combat vinculada esta en curso. */
  InProgress: 'IN_PROGRESS',
  /** Combat informo un resultado autoritativo. Es un estado terminal. */
  Finished: 'FINISHED',
} as const

export type TournamentMatchStatus =
  (typeof TournamentMatchStatus)[keyof typeof TournamentMatchStatus]

export interface TournamentEncounterParticipant {
  readonly playerId: string
  readonly heroId: string
}

export interface TournamentEncounterTeam {
  readonly teamId: string
  readonly teamLabel: string
  readonly participants: readonly TournamentEncounterParticipant[]
}

/**
 * Resultado autoritativo de Combat para una justa finalizada.
 *
 * `winnerTeamLabel` puede ser `null`: Combat reconoce un desenlace sin ganador
 * (`NO_WINNER`, p. ej. doble abandono). Eso NO es lo mismo que "no hay
 * resultado todavia" — una justa `IN_PROGRESS` no tiene `TournamentMatchResult`
 * en absoluto, tiene `null` en el campo `result` del encuentro.
 */
export interface TournamentMatchResult {
  readonly winnerTeamLabel: string | null
  readonly reason: string
  readonly outcome: string
  readonly finishedAt: Date
}

/**
 * Vocabulario de estado de la SALA de Combat, duplicado aqui a proposito desde
 * el puerto `CombatRecordPort` (`application/ports/CombatRecordPort.ts`).
 *
 * El dominio no puede importar la capa de aplicacion (lo impone ESLint): esta
 * union literal es estructuralmente identica a la que declara el puerto, asi
 * que TypeScript las acepta sin un import cruzado. Es el mismo patron que ya
 * usa este equipo para `Role` entre servicios: el precio es la copia: el
 * beneficio es que el dominio no conoce el contrato con Combat, solo el suyo.
 */
export type CombatRoomStatus = 'PREPARING' | 'IN_BATTLE' | 'FINISHED'

export interface EncounterBracketMetadata {
  readonly bracketTrack: 'MAIN' | 'SECONDARY' | 'FINAL'
  readonly registeredTeams: readonly ({
    teamId: string
    name: string
    avatar: TeamAvatar
    memberIds: readonly [string, string]
  } | null)[]
  readonly preparationStatus:
    | 'WAITING_TEAMS'
    | 'TEAMS_RESOLVED'
    | 'PREPARING'
    | 'PREPARED'
    | 'START_PENDING'
    | 'IN_BATTLE'
    | 'FINISHED'
  readonly engineLastSeq: number | null
  readonly syncedAt: string | null
}

export interface TournamentEncounter {
  readonly bracketMetadata?: EncounterBracketMetadata
  readonly tournamentId: string
  readonly encounterId: string
  /** Ronda del bracket, 1-indexada. El avance del bracket es HU-80, no esto. */
  readonly round: number
  /** Identificador legible de la justa dentro del bracket, p. ej. "E1". */
  readonly bracketLabel: string
  /** Vacio mientras el bracket no resuelva los equipos (`WaitingParticipants`). */
  readonly teams: readonly TournamentEncounterTeam[]
  readonly status: TournamentMatchStatus
  /** Sala de Combat vinculada (HU-85). `null` mientras no exista vinculo. */
  readonly combatRoomId: string | null
  readonly startedAt: Date | null
  readonly closedAt: Date | null
  readonly result: TournamentMatchResult | null
  /** Ultima secuencia de evento de Combat ya proyectada. 0 si ninguna. */
  readonly lastSyncedSeq: number
  /** Cierto si la proyeccion alcanzo el ultimo `seq` que Combat conocia. */
  readonly logComplete: boolean
}

/**
 * Entrada de la proyeccion de Combat que se aplica sobre una justa existente.
 *
 * Es deliberadamente mas pobre que `CombatRoomRecord` del puerto: la entidad
 * de dominio no necesita (ni debe) conocer los eventos en si, solo lo que
 * cambia su propio estado. Los eventos se conservan aparte, en
 * `CombatEventRecord`, en una tabla de solo-anadir.
 */
export interface CombatProjectionInput {
  readonly status: CombatRoomStatus
  readonly startedAt: Date | null
  readonly result: TournamentMatchResult | null
  readonly lastSeq: number
  readonly logComplete: boolean
}

/**
 * Aplica lo que Combat informa sobre su sala a una justa, preservando los
 * invariantes exigidos por CA-03 y CA-04 de HU-83 (Management#465):
 *
 * - Una justa `FINISHED` es terminal: ni su resultado ni su `closedAt` cambian
 *   jamas, sin importar que vuelva a llegar el mismo evento de cierre u otro
 *   distinto. Reenviar el cierre no duplica ni cambia lo ya fijado (CA-03).
 * - Nunca se marca `FINISHED` sin un resultado autoritativo que lo acompane:
 *   sin eso se quedaria `InProgress`. Una justa en curso jamas muestra un
 *   ganador o una fecha de cierre inventados (CA-04).
 * - `lastSyncedSeq` solo avanza, nunca retrocede: es la marca de hasta donde
 *   se leyo el archivo de Combat, y una lectura mas corta no debe "olvidar"
 *   lo ya leido.
 * - `startedAt` se fija una vez y no se reescribe: es el instante autoritativo
 *   que Combat informo la primera vez que se supo.
 */
export const applyCombatProjection = (
  encounter: TournamentEncounter,
  projection: CombatProjectionInput,
): TournamentEncounter => {
  const lastSyncedSeq = Math.max(encounter.lastSyncedSeq, projection.lastSeq)
  const logComplete = projection.logComplete

  if (encounter.status === TournamentMatchStatus.Finished) {
    // Terminal: solo se permite seguir leyendo eventos sobrantes del archivo.
    // El resultado y el cierre, una vez fijados, no se tocan.
    return { ...encounter, lastSyncedSeq, logComplete }
  }

  const startedAt = encounter.startedAt ?? projection.startedAt

  if (projection.status === 'FINISHED' && projection.result !== null) {
    return {
      ...encounter,
      status: TournamentMatchStatus.Finished,
      startedAt,
      closedAt: projection.result.finishedAt,
      result: projection.result,
      lastSyncedSeq,
      logComplete,
    }
  }

  // Combat dice "finalizada" pero todavia no trae resultado, o sigue en curso:
  // en ningun caso se inventa un ganador ni un cierre.
  return {
    ...encounter,
    status: projection.status === 'IN_BATTLE' ? TournamentMatchStatus.InProgress : encounter.status,
    startedAt,
    closedAt: null,
    result: null,
    lastSyncedSeq,
    logComplete,
  }
}
