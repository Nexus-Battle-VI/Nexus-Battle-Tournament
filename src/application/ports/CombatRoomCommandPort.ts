/**
 * Puerto de ESCRITURA hacia las salas de torneo de Combat (HU-85). La lectura
 * del registro sigue siendo `CombatRecordPort`. El adaptador HTTP firma con HMAC
 * y traduce los errores de Combat a `RegistrationError`.
 */
export interface CombatRoomTeamInput {
  readonly teamId: string
  readonly memberIds: readonly [string, string]
}

export interface CreateCombatRoomInput {
  readonly operationId: string
  readonly tournamentId: string
  readonly encounterId: string
  readonly teams: readonly [CombatRoomTeamInput, CombatRoomTeamInput]
}

export interface StartCombatRoomInput {
  readonly operationId: string
  readonly tournamentId: string
  readonly encounterId: string
}

export interface CombatRoomCommandPort {
  /** Idempotente por `operationId`: el mismo cuerpo devuelve siempre la misma sala. */
  createRoom(input: CreateCombatRoomInput): Promise<{ readonly roomId: string }>
  /** Idempotente: reenviar el inicio no crea un segundo combate. */
  startRoom(roomId: string, input: StartCombatRoomInput): Promise<void>
}

export const COMBAT_ROOM_COMMANDS = Symbol('CombatRoomCommandPort')
