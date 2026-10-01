import type { CombatEventPage, CombatEventRecord } from '../../../domain/entities/CombatEventRecord'
import type { TournamentEncounter } from '../../../domain/entities/TournamentEncounter'
import type { TournamentEncounterRepositoryPort } from '../../../application/ports/TournamentEncounterRepositoryPort'

const key = (tournamentId: string, encounterId: string): string => `${tournamentId}:${encounterId}`

/**
 * Adaptador en memoria. Usado con `PERSISTENCE_DRIVER=memory` (desarrollo y
 * pruebas rapidas) y directamente en las pruebas unitarias de los casos de
 * uso. El estado se pierde al reiniciar el proceso: nunca es el adaptador de
 * produccion (vease ADR-022 y `env.ts`, que impide arrancar en produccion con
 * este driver).
 */
export class InMemoryTournamentEncounterRepository implements TournamentEncounterRepositoryPort {
  private readonly encounters = new Map<string, TournamentEncounter>()
  private readonly events = new Map<string, CombatEventRecord[]>()

  findAllByTournament(tournamentId: string): Promise<readonly TournamentEncounter[]> {
    return Promise.resolve(
      [...this.encounters.values()].filter((encounter) => encounter.tournamentId === tournamentId),
    )
  }

  findOne(tournamentId: string, encounterId: string): Promise<TournamentEncounter | null> {
    return Promise.resolve(this.encounters.get(key(tournamentId, encounterId)) ?? null)
  }

  save(encounter: TournamentEncounter): Promise<void> {
    this.encounters.set(key(encounter.tournamentId, encounter.encounterId), encounter)

    return Promise.resolve()
  }

  appendEvents(events: readonly CombatEventRecord[]): Promise<void> {
    for (const event of events) {
      const bucketKey = key(event.tournamentId, event.encounterId)
      const bucket = this.events.get(bucketKey) ?? []

      // Idempotente: un `seq` ya presente se descarta, igual que la
      // restriccion unica del esquema de PostgreSQL (CA-03).
      if (bucket.some((existing) => existing.seq === event.seq)) {
        continue
      }

      bucket.push(event)
      bucket.sort((a, b) => a.seq - b.seq)
      this.events.set(bucketKey, bucket)
    }

    return Promise.resolve()
  }

  listEvents(
    tournamentId: string,
    encounterId: string,
    afterSeq: number,
    limit: number,
  ): Promise<CombatEventPage> {
    const bucket = this.events.get(key(tournamentId, encounterId)) ?? []
    const remaining = bucket.filter((event) => event.seq > afterSeq)
    const page = remaining.slice(0, limit)
    const lastInPage = page.at(-1)?.seq ?? afterSeq

    return Promise.resolve({
      events: page,
      nextSeq: lastInPage,
      hasMore: remaining.length > page.length,
    })
  }
}
