import { InMemoryTournamentEncounterRepository } from '../../src/adapters/outbound/persistence/InMemoryTournamentEncounterRepository'
import type { CombatEventRecord } from '../../src/domain/entities/CombatEventRecord'

const eventOf = (seq: number, type = 'turnResolved'): CombatEventRecord => ({
  tournamentId: 'T1',
  encounterId: 'E1',
  seq,
  type,
  payload: { seq },
  occurredAt: new Date('2026-09-30T20:00:00Z'),
})

describe('InMemoryTournamentEncounterRepository', () => {
  it('encuentra null cuando la justa no existe', async () => {
    const repository = new InMemoryTournamentEncounterRepository()

    await expect(repository.findOne('T1', 'E1')).resolves.toBeNull()
  })

  /** CA-03 a nivel de persistencia: un evento con el mismo seq no se duplica. */
  it('appendEvents es idempotente: un seq repetido no se duplica ni se sobrescribe', async () => {
    const repository = new InMemoryTournamentEncounterRepository()

    await repository.appendEvents([eventOf(1, 'battleStarted'), eventOf(2)])
    // Reenvio del mismo seq con OTRO payload: se descarta, no se sobrescribe.
    await repository.appendEvents([eventOf(1, 'tipo-distinto'), eventOf(3)])

    const page = await repository.listEvents('T1', 'E1', 0, 100)

    expect(page.events.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(page.events[0]?.type).toBe('battleStarted')
  })

  it('listEvents respeta el limite y reporta hasMore/nextSeq', async () => {
    const repository = new InMemoryTournamentEncounterRepository()
    await repository.appendEvents([eventOf(1), eventOf(2), eventOf(3), eventOf(4)])

    const page = await repository.listEvents('T1', 'E1', 0, 2)

    expect(page.events.map((e) => e.seq)).toEqual([1, 2])
    expect(page.hasMore).toBe(true)
    expect(page.nextSeq).toBe(2)

    const next = await repository.listEvents('T1', 'E1', page.nextSeq, 2)
    expect(next.events.map((e) => e.seq)).toEqual([3, 4])
    expect(next.hasMore).toBe(false)
  })

  it('listEvents de una justa sin eventos devuelve una pagina vacia', async () => {
    const repository = new InMemoryTournamentEncounterRepository()

    const page = await repository.listEvents('T1', 'E1', 0, 100)

    expect(page.events).toEqual([])
    expect(page.hasMore).toBe(false)
    expect(page.nextSeq).toBe(0)
  })
})
