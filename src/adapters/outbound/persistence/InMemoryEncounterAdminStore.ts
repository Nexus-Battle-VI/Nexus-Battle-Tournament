import type {
  EncounterAdminAction,
  EncounterAdminActionRecord,
} from '../../../domain/encounter-admin'
import { RegistrationError } from '../../../domain/registration'
import type { EncounterAdminStore } from '../../../application/ports/EncounterAdminPorts'

export class InMemoryEncounterAdminStore implements EncounterAdminStore {
  private readonly records: EncounterAdminActionRecord[] = []

  findByOperation(tournamentId: string, operationId: string) {
    return Promise.resolve(
      this.records.find((r) => r.tournamentId === tournamentId && r.operationId === operationId) ??
        null,
    )
  }

  findByAction(tournamentId: string, encounterId: string, action: EncounterAdminAction) {
    return Promise.resolve(
      this.records.find(
        (r) =>
          r.tournamentId === tournamentId && r.encounterId === encounterId && r.action === action,
      ) ?? null,
    )
  }

  insert(record: EncounterAdminActionRecord): Promise<EncounterAdminActionRecord> {
    const sameAction = this.records.find(
      (r) =>
        r.tournamentId === record.tournamentId &&
        r.encounterId === record.encounterId &&
        r.action === record.action,
    )
    if (sameAction !== undefined) return Promise.resolve(sameAction)
    if (
      this.records.some(
        (r) => r.tournamentId === record.tournamentId && r.operationId === record.operationId,
      )
    )
      return Promise.reject(
        new RegistrationError(
          'OPERATION_CONFLICT',
          'El identificador corresponde a otra intención.',
          409,
        ),
      )
    this.records.push(record)
    return Promise.resolve(record)
  }

  list(tournamentId: string) {
    return Promise.resolve(
      this.records
        .filter((r) => r.tournamentId === tournamentId)
        .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()),
    )
  }
}
