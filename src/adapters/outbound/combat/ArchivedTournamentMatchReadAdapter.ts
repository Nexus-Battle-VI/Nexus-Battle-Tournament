import type { TournamentMatchReadPort } from '../../../application/ports/TournamentMatchReadPort'
import type { TournamentEncounterRepositoryPort } from '../../../application/ports/TournamentEncounterRepositoryPort'
import type { CombatRecordPort } from '../../../application/ports/CombatRecordPort'
import { ProjectCombatRecord } from '../../../application/use-cases/ProjectCombatRecord'
import type { MatchRead } from '../../../domain/match-read'
import { sameJson } from '../../../domain/json'
import { requireRule } from '../../../domain/registration'
import type { CombatEventRecord } from '../../../domain/entities/CombatEventRecord'

/** Fuente real: proyección oficial HU-83 + lectura HTTP existente. Nunca crea/inicia salas. */
export class ArchivedTournamentMatchReadAdapter implements TournamentMatchReadPort {
  private readonly projector: ProjectCombatRecord
  constructor(
    private readonly repository: TournamentEncounterRepositoryPort,
    combat: CombatRecordPort,
  ) {
    this.projector = new ProjectCombatRecord(repository, combat)
  }
  async list(id: string): Promise<readonly MatchRead[]> {
    const encounters = await this.repository.findAllByTournament(id)
    const items: MatchRead[] = []
    for (const e of encounters) {
      const item = await this.read(id, e.encounterId)
      if (item !== null) items.push(item)
    }
    return items
  }
  async read(id: string, encounterId: string): Promise<MatchRead | null> {
    const stored = await this.repository.findOne(id, encounterId)
    if (stored === null) return null
    const e =
      stored.combatRoomId === null || (stored.status === 'FINISHED' && stored.logComplete)
        ? stored
        : await this.projector.execute(id, encounterId)
    const events: CombatEventRecord[] = []
    let cursor = 0
    while (cursor < e.lastSyncedSeq) {
      const page = await this.repository.listEvents(id, encounterId, cursor, 100)
      requireRule(
        page.events.length > 0 &&
          page.events.every(
            (event, i) =>
              event.tournamentId === id &&
              event.encounterId === encounterId &&
              event.seq === cursor + i + 1 &&
              event.seq <= e.lastSyncedSeq,
          ) &&
          page.nextSeq === page.events.at(-1)?.seq,
        'ARCHIVE_INCOMPLETE',
        'El archivo de HU-83 tiene un hueco o un cursor incompatible.',
        503,
      )
      events.push(...page.events)
      cursor = page.nextSeq
    }
    const serialized = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown
    requireRule(
      sameJson(serialized(e), serialized(await this.repository.findOne(id, encounterId))),
      'MATCH_READ_CHANGED',
      'El archivo cambió durante la lectura; vuelve a consultar.',
      409,
    )
    return {
      tournamentId: e.tournamentId,
      encounterId: e.encounterId,
      bracketLabel: e.bracketLabel,
      track: e.bracketMetadata?.bracketTrack ?? null,
      round: e.round,
      status: e.status,
      combatRoomId: e.combatRoomId,
      teams: structuredClone(e.teams),
      startedAt: e.startedAt?.toISOString() ?? null,
      closedAt: e.closedAt?.toISOString() ?? null,
      result:
        e.result === null ? null : { ...e.result, finishedAt: e.result.finishedAt.toISOString() },
      lastSyncedSeq: e.lastSyncedSeq,
      engineLastSeq: e.bracketMetadata?.engineLastSeq ?? null,
      logComplete: e.logComplete,
      events,
    }
  }
}
