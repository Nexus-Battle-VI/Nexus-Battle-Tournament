import type { EncounterAdminAction, EncounterAdminActionRecord } from '../../domain/encounter-admin'

/** Recibos durables de las acciones administrativas aceptadas sobre las justas. */
export interface EncounterAdminStore {
  findByOperation(
    tournamentId: string,
    operationId: string,
  ): Promise<EncounterAdminActionRecord | null>
  findByAction(
    tournamentId: string,
    encounterId: string,
    action: EncounterAdminAction,
  ): Promise<EncounterAdminActionRecord | null>
  /**
   * Inserta el recibo. Si la justa ya tiene uno de esa accion devuelve el
   * existente (nunca hay dos); si el `operationId` ya es de otra accion o
   * justa lanza `OPERATION_CONFLICT`.
   */
  insert(record: EncounterAdminActionRecord): Promise<EncounterAdminActionRecord>
  list(tournamentId: string): Promise<readonly EncounterAdminActionRecord[]>
}

export const ENCOUNTER_ADMIN_STORE = Symbol('EncounterAdminStore')
