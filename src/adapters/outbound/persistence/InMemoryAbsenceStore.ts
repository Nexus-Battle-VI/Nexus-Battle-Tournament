import type { AbsenceResolution, ReadinessRecord } from '../../../domain/absence'
import type { AbsenceStore } from '../../../application/ports/AbsencePorts'

export class InMemoryAbsenceStore implements AbsenceStore {
  private readonly ready: ReadinessRecord[] = []
  private readonly resolutions: AbsenceResolution[] = []

  accept(record: ReadinessRecord): Promise<void> {
    const exists = this.ready.some(
      (r) =>
        r.tournamentId === record.tournamentId &&
        r.encounterId === record.encounterId &&
        r.playerId === record.playerId,
    )
    if (!exists) this.ready.push(record)
    return Promise.resolve()
  }

  listReady(tournamentId: string, encounterId: string): Promise<readonly ReadinessRecord[]> {
    return Promise.resolve(
      this.ready.filter((r) => r.tournamentId === tournamentId && r.encounterId === encounterId),
    )
  }

  findResolution(tournamentId: string, encounterId: string): Promise<AbsenceResolution | null> {
    return Promise.resolve(
      this.resolutions.find(
        (r) => r.tournamentId === tournamentId && r.encounterId === encounterId,
      ) ?? null,
    )
  }

  saveResolution(resolution: AbsenceResolution): Promise<AbsenceResolution> {
    const existing = this.resolutions.find(
      (r) => r.tournamentId === resolution.tournamentId && r.encounterId === resolution.encounterId,
    )
    if (existing !== undefined) return Promise.resolve(existing)
    this.resolutions.push(resolution)
    return Promise.resolve(resolution)
  }
}
