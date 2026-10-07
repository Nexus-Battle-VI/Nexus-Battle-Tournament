import { RegistrationError } from './registration'

export type EncounterAdminAction = 'PREPARE' | 'START'

/** Recibo de una accion administrativa ACEPTADA sobre una justa (HU-85, CA-01). */
export interface EncounterAdminActionRecord {
  readonly actionId: string
  readonly tournamentId: string
  readonly encounterId: string
  readonly action: EncounterAdminAction
  readonly actor: string
  readonly operationId: string
  readonly combatRoomId: string
  readonly occurredAt: Date
}

/** Combat rechazo a un participante; `blockers` se reenvia tal cual, sin inventar nada. */
export class CombatRejectedError extends RegistrationError {
  constructor(
    message: string,
    readonly blockers: readonly unknown[],
  ) {
    super('COMBAT_REJECTED_PARTICIPANTS', message, 422)
  }
}
