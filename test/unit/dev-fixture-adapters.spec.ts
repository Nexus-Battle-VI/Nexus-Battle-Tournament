import { DevFixtureTournamentEncounterSource } from '../../src/adapters/outbound/bracket/DevFixtureTournamentEncounterSource'
import { DevFixtureCombatRecordAdapter } from '../../src/adapters/outbound/combat/DevFixtureCombatRecordAdapter'
import { TournamentMatchStatus } from '../../src/domain/entities/TournamentEncounter'

describe('DevFixtureTournamentEncounterSource (fixture de desarrollo, no es el bracket real)', () => {
  it('devuelve E1-E4 con los cuatro estados exigidos por HU-83', async () => {
    const encounters = await new DevFixtureTournamentEncounterSource().listEncounters('T1')

    expect(encounters.map((e) => e.encounterId).sort()).toEqual(['E1', 'E2', 'E3', 'E4'])
    expect(encounters.find((e) => e.encounterId === 'E1')?.status).toBe(TournamentMatchStatus.Ready)
    expect(encounters.find((e) => e.encounterId === 'E4')?.status).toBe(
      TournamentMatchStatus.WaitingParticipants,
    )
  })

  it('estampa el tournamentId recibido en cada justa, sin mezclar torneos (CA-01)', async () => {
    const source = new DevFixtureTournamentEncounterSource()

    const t1 = await source.listEncounters('T1')
    const t2 = await source.listEncounters('T2')

    expect(t1.every((e) => e.tournamentId === 'T1')).toBe(true)
    expect(t2.every((e) => e.tournamentId === 'T2')).toBe(true)
    expect(t1.find((e) => e.encounterId === 'E2')?.combatRoomId).toBe('room-T1-E2')
    expect(t2.find((e) => e.encounterId === 'E2')?.combatRoomId).toBe('room-T2-E2')
  })

  /**
   * Limitacion deliberada del fixture (ver el comentario en la clase): solo
   * fabrica justas para una lista fija de `tournamentId` de desarrollo
   * conocidos. Un id inventado no debe aparentar ser un torneo valido.
   */
  it('devuelve una lista vacia para un tournamentId que no esta en la lista conocida', async () => {
    const encounters = await new DevFixtureTournamentEncounterSource().listEncounters(
      'torneo-inventado-que-no-existe',
    )

    expect(encounters).toEqual([])
  })
})

describe('DevFixtureCombatRecordAdapter (fixture de desarrollo, no es Combat real)', () => {
  it('informa una sala en curso sin resultado (CA-04)', async () => {
    const record = await new DevFixtureCombatRecordAdapter().readRecord('room-T1-E2', 0)

    expect(record.status).toBe('IN_BATTLE')
    expect(record.result).toBeNull()
    expect(record.tournamentId).toBe('T1')
    expect(record.encounterId).toBe('E2')
    expect(record.events.length).toBeGreaterThan(0)
    expect(record.events.every((event) => event.roomId === record.roomId)).toBe(true)
  })

  it('informa una sala finalizada con resultado autoritativo', async () => {
    const record = await new DevFixtureCombatRecordAdapter().readRecord('room-T1-E3', 0)

    expect(record.status).toBe('FINISHED')
    expect(record.result?.winnerTeamLabel).toBe('A')
    expect(record.lastSeq).toBe(record.events.length)
  })

  it('pagina desde afterSeq, devolviendo solo eventos posteriores', async () => {
    const adapter = new DevFixtureCombatRecordAdapter()
    const full = await adapter.readRecord('room-T1-E3', 0)
    const partial = await adapter.readRecord('room-T1-E3', 2)

    expect(partial.events.every((event) => event.seq > 2)).toBe(true)
    expect(partial.events.length).toBe(full.events.length - 2)
  })

  it('rechaza una sala que no reconoce', async () => {
    const adapter = new DevFixtureCombatRecordAdapter()

    await expect(adapter.readRecord('sala-sin-formato', 0)).rejects.toThrow()
    await expect(adapter.readRecord('room-T1-E999', 0)).rejects.toThrow()
  })
})
