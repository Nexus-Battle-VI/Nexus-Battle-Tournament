import { startTestPostgres } from '../support/postgres'
import type { Kysely } from 'kysely'

import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import { PostgresTournamentEncounterRepository } from '../../src/adapters/outbound/persistence/PostgresTournamentEncounterRepository'
import {
  TournamentMatchStatus,
  type TournamentEncounter,
} from '../../src/domain/entities/TournamentEncounter'
import type { CombatEventRecord } from '../../src/domain/entities/CombatEventRecord'

/**
 * Persistencia propia de HU-83 (Management#465) contra un PostgreSQL REAL,
 * incluyendo la migracion `001-tournament-encounters`. Lo que no se puede
 * comprobar con el adaptador en memoria: que la restriccion de unicidad del
 * esquema, y no solo el dominio o el adaptador, es lo que impide duplicar un
 * evento ya guardado (CA-03).
 */
describe('PostgresTournamentEncounterRepository', () => {
  let container: Awaited<ReturnType<typeof startTestPostgres>>
  let db: Kysely<Database>
  let repository: PostgresTournamentEncounterRepository

  beforeAll(async () => {
    container = await startTestPostgres()
    db = createDatabase({ connectionString: container.connectionString })
    const outcome = await migrateToLatest(db)
    if (outcome.error !== undefined) {
      throw outcome.error instanceof Error ? outcome.error : new Error('La migracion fallo.')
    }
    repository = new PostgresTournamentEncounterRepository(db)
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  const encounterOf = (tournamentId: string, encounterId: string): TournamentEncounter => ({
    tournamentId,
    encounterId,
    round: 1,
    bracketLabel: encounterId,
    teams: [
      { teamId: 'a', teamLabel: 'A', participants: [{ playerId: 'p1', heroId: 'h1' }] },
      { teamId: 'b', teamLabel: 'B', participants: [{ playerId: 'p2', heroId: 'h2' }] },
    ],
    status: TournamentMatchStatus.Ready,
    combatRoomId: null,
    startedAt: null,
    closedAt: null,
    result: null,
    lastSyncedSeq: 0,
    logComplete: false,
  })

  it('guarda y recupera una justa por torneo y por identificador', async () => {
    await repository.save(encounterOf('T1', 'E1'))

    const all = await repository.findAllByTournament('T1')
    const found = await repository.findOne('T1', 'E1')

    expect(all).toHaveLength(1)
    expect(found?.encounterId).toBe('E1')
  })

  it('dos torneos con la misma etiqueta de justa no colisionan (CA-01)', async () => {
    await repository.save(encounterOf('T-colision-a', 'E1'))
    await repository.save(encounterOf('T-colision-b', 'E1'))

    const a = await repository.findOne('T-colision-a', 'E1')
    const b = await repository.findOne('T-colision-b', 'E1')

    expect(a?.tournamentId).toBe('T-colision-a')
    expect(b?.tournamentId).toBe('T-colision-b')
  })

  it('save es upsert: guardar de nuevo la misma justa actualiza, no duplica', async () => {
    await repository.save(encounterOf('T-upsert', 'E1'))
    const finished: TournamentEncounter = {
      ...encounterOf('T-upsert', 'E1'),
      status: TournamentMatchStatus.Finished,
      closedAt: new Date('2026-09-30T20:00:00.000Z'),
      result: {
        winnerTeamLabel: 'A',
        reason: 'OPPONENT_DEFEATED',
        outcome: 'VICTORY',
        finishedAt: new Date('2026-09-30T20:00:00.000Z'),
      },
    }

    await repository.save(finished)

    const all = await repository.findAllByTournament('T-upsert')
    expect(all).toHaveLength(1)
    expect(all[0]?.status).toBe(TournamentMatchStatus.Finished)
    expect(all[0]?.result?.winnerTeamLabel).toBe('A')
  })

  /**
   * El invariante real de CA-03: la restriccion unica de la migracion, no
   * solo el chequeo del adaptador en memoria, es lo que impide reescribir o
   * duplicar un evento ya guardado.
   */
  it('appendEvents es idempotente por la restriccion unica del esquema (CA-03)', async () => {
    await repository.save(encounterOf('T-eventos', 'E1'))

    const eventOf = (seq: number, type: string): CombatEventRecord => ({
      tournamentId: 'T-eventos',
      encounterId: 'E1',
      seq,
      type,
      payload: { seq },
      occurredAt: new Date('2026-09-30T20:00:00.000Z'),
    })

    await repository.appendEvents([eventOf(1, 'battleStarted'), eventOf(2, 'turnResolved')])
    // Reintento: mismo seq 1, payload distinto. No debe reescribirse ni fallar.
    await repository.appendEvents([eventOf(1, 'reintento-distinto'), eventOf(3, 'turnResolved')])

    const page = await repository.listEvents('T-eventos', 'E1', 0, 100)

    expect(page.events.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(page.events[0]?.type).toBe('battleStarted')
  })

  it('listEvents pagina en grupos de hasta `limit` y reporta hasMore/nextSeq', async () => {
    await repository.save(encounterOf('T-paginacion', 'E1'))

    const events: CombatEventRecord[] = Array.from({ length: 5 }, (_, index) => ({
      tournamentId: 'T-paginacion',
      encounterId: 'E1',
      seq: index + 1,
      type: 'turnResolved',
      payload: {},
      occurredAt: new Date('2026-09-30T20:00:00.000Z'),
    }))
    await repository.appendEvents(events)

    const first = await repository.listEvents('T-paginacion', 'E1', 0, 2)
    expect(first.events.map((e) => e.seq)).toEqual([1, 2])
    expect(first.hasMore).toBe(true)
    expect(first.nextSeq).toBe(2)

    const rest = await repository.listEvents('T-paginacion', 'E1', first.nextSeq, 10)
    expect(rest.events.map((e) => e.seq)).toEqual([3, 4, 5])
    expect(rest.hasMore).toBe(false)
  })

  it('una justa sin eventos devuelve una pagina vacia, no un error', async () => {
    await repository.save(encounterOf('T-vacio', 'E1'))

    const page = await repository.listEvents('T-vacio', 'E1', 0, 100)

    expect(page.events).toEqual([])
    expect(page.hasMore).toBe(false)
  })
})
