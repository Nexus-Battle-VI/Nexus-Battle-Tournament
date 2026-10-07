import { ProjectCombatRecord } from '../../src/application/use-cases/ProjectCombatRecord'
import { ListTournamentMatches } from '../../src/application/use-cases/ListTournamentMatches'
import type {
  CombatRoomRecord,
  CombatRecordPort,
} from '../../src/application/ports/CombatRecordPort'
import { PersistedBracketEncounterSource } from '../../src/adapters/outbound/bracket/PersistedBracketEncounterSource'
import { mergeArchivedEncounter } from '../../src/domain/archive'
import { fixture, FREE_POLICY } from '../support/registration-fixture'
import { CombatRecordReconciler } from '../../src/infrastructure/scheduling/combat-record-reconciler'
import { RegistrationReconciler } from '../../src/infrastructure/scheduling/registration-reconciler'
import { modeFixture } from '../support/modalities-fixture'
const setup = async () => {
  const f = fixture(undefined, FREE_POLICY),
    t = await f.create()
  for (let n = 0; n < 8; n++) await f.confirm(t.id, n)
  await f.brackets.publish(t.id, 'admin', 'pub')
  const seed = (await f.encounters.findOne(t.id, t.id + ':E1'))!
  await f.encounters.save({ ...seed, combatRoomId: 'synthetic-room' })
  const record: CombatRoomRecord = {
    roomId: 'synthetic-room',
    tournamentId: t.id,
    encounterId: seed.encounterId,
    status: 'IN_BATTLE',
    startedAt: new Date('2026-10-05T12:00:00Z'),
    result: null,
    afterSeq: 0,
    lastSeq: 1,
    teams: [
      {
        teamLabel: 'BLUE',
        participants: [
          { playerId: 'p1', heroId: 'fixture-h-p1' },
          { playerId: 'q1', heroId: 'fixture-h-q1' },
        ],
      },
      {
        teamLabel: 'RED',
        participants: [
          { playerId: 'p0', heroId: 'fixture-h-p0' },
          { playerId: 'q0', heroId: 'fixture-h-q0' },
        ],
      },
    ],
    events: [
      {
        roomId: 'synthetic-room',
        seq: 1,
        type: 'battleStarted',
        occurredAt: new Date('2026-10-05T12:00:00Z'),
        payload: { synthetic: true },
      },
    ],
  }
  const combat: CombatRecordPort = { readRecord: jest.fn(() => Promise.resolve(record)) }
  return { f, t, seed, record, combat, projector: new ProjectCombatRecord(f.encounters, combat) }
}
describe('Archivo compatible: datos de Combat sintéticos explícitos', () => {
  it('una proyección anterior conserva modalidad/calendario; otra configuración y roster ya resuelto se rechazan', async () => {
    const f = await modeFixture('TRIO'),
      b = await f.publish()
    const current = (await f.encounters.findOne(f.id, b.matches[0]!.encounterId))!
    const incoming = {
      ...current,
      bracketMetadata: {
        ...current.bracketMetadata!,
        tournamentMode: undefined,
        teamSize: undefined,
        acceptancePolicy: undefined,
      },
    }
    expect(mergeArchivedEncounter(current, incoming).bracketMetadata).toMatchObject({
      tournamentMode: 'TRIO',
      teamSize: 3,
      acceptancePolicy: 'ROUND_ACCEPTANCE_V1',
    })
    expect(() =>
      mergeArchivedEncounter(current, {
        ...incoming,
        bracketMetadata: { ...incoming.bracketMetadata, tournamentMode: 'SOLO' },
      }),
    ).toThrow('configuración archivada')
    const changedTeams = [...current.bracketMetadata!.registeredTeams]
    changedTeams[0] = { ...changedTeams[0]!, memberIds: ['foreign'] }
    expect(() =>
      mergeArchivedEncounter(current, {
        ...incoming,
        bracketMetadata: { ...incoming.bracketMetadata, registeredTeams: changedTeams },
      }),
    ).toThrow('equipo ya resuelto')
  })
  it('vincula por miembros aunque Combat invierta orden, traduce estado y conserva snapshot', async () => {
    const { f, t, record, projector } = await setup()
    const before = await f.brackets.view(t.id)
    const projected = await projector.execute(t.id, record.encounterId)
    expect(projected.status).toBe('IN_PROGRESS')
    expect(projected.teams[0]?.teamId).toBe(before?.seeds[1]?.teamId)
    expect(projected.teams[1]?.teamId).toBe(before?.seeds[0]?.teamId)
    expect(projected.bracketMetadata).toMatchObject({
      preparationStatus: 'IN_BATTLE',
      engineLastSeq: 1,
    })
    expect(projected.bracketMetadata?.syncedAt).toEqual(expect.any(String))
    expect(await f.brackets.view(t.id)).toEqual(before)
  })
  it('sin roster de motor no marca preparada una justa nueva', async () => {
    const { record, combat, projector, f, t } = await setup()
    jest.spyOn(combat, 'readRecord').mockResolvedValue({ ...record, teams: undefined })
    await expect(projector.execute(t.id, record.encounterId)).rejects.toThrow('roster')
    expect((await f.encounters.findOne(t.id, record.encounterId))?.status).toBe(
      'WAITING_PARTICIPANTS',
    )
  })
  it('secuencia saltada y miembros ajenos no se archivan', async () => {
    const { record, combat, projector, f, t } = await setup()
    jest
      .spyOn(combat, 'readRecord')
      .mockResolvedValue({ ...record, events: [{ ...record.events[0]!, seq: 3 }] })
    await expect(projector.execute(t.id, record.encounterId)).rejects.toThrow('secuencias')
    jest.spyOn(combat, 'readRecord').mockResolvedValue({
      ...record,
      teams: [{ teamLabel: 'FOREIGN', participants: [{ playerId: 'otro', heroId: 'fixture' }] }],
    })
    await expect(projector.execute(t.id, record.encounterId)).rejects.toThrow('miembros')
    expect((await f.encounters.listEvents(t.id, record.encounterId, 0, 100)).events).toEqual([])
  })
  it('evento ya escrito antes de perder cursor no puede reescribirse con otro payload', async () => {
    const { record, projector, f, t } = await setup()
    await f.encounters.appendEvents([
      {
        ...record.events[0]!,
        tournamentId: t.id,
        encounterId: record.encounterId,
        payload: { previous: true },
      },
    ])
    await expect(projector.execute(t.id, record.encounterId)).rejects.toThrow('reescribir')
    expect(
      (await f.encounters.listEvents(t.id, record.encounterId, 0, 100)).events[0]?.payload,
    ).toEqual({ previous: true })
  })
  it('reinicio tras guardar evento recupera cursor con JSON equivalente y conserva snapshot', async () => {
    const { record, projector, f, t } = await setup()
    const event = record.events[0]!
    await f.encounters.appendEvents([
      {
        ...event,
        tournamentId: t.id,
        encounterId: record.encounterId,
        payload: structuredClone(event.payload),
      },
    ])
    await expect(projector.execute(t.id, record.encounterId)).resolves.toMatchObject({
      lastSyncedSeq: 1,
    })
    expect((await f.encounters.listEvents(t.id, record.encounterId, 0, 100)).events).toHaveLength(1)
    const before = await f.brackets.view(t.id)
    await expect(
      f.repo.change(t.id, (current) => {
        current.bracket!.publishedBy = 'otro'
      }),
    ).rejects.toMatchObject({ code: 'IMMUTABLE_BRACKET' })
    expect(await f.brackets.view(t.id)).toEqual(before)
  })
  it('no cambia etiquetas de motor ni héroes después de archivar el roster', async () => {
    const { record, projector, combat, f, t } = await setup()
    await projector.execute(t.id, record.encounterId)
    const original = await f.encounters.findOne(t.id, record.encounterId)
    for (const changed of ['label', 'hero']) {
      const teams = [...structuredClone(record.teams!)]
      teams[0] = {
        ...teams[0]!,
        ...(changed === 'label'
          ? { teamLabel: 'CHANGED' }
          : {
              participants: [
                { ...teams[0]!.participants[0]!, heroId: 'otro-héroe' },
                teams[0]!.participants[1]!,
              ],
            }),
      }
      jest
        .spyOn(combat, 'readRecord')
        .mockResolvedValue({ ...record, afterSeq: 1, events: [], teams })
      await expect(projector.execute(t.id, record.encounterId)).rejects.toThrow('miembros')
      expect(await f.encounters.findOne(t.id, record.encounterId)).toEqual(original)
    }
  })
  it('caída de Combat deja consultable el archivo verificado y no inventa cierre', async () => {
    const { record, projector, combat, f, t } = await setup()
    await projector.execute(t.id, record.encounterId)
    jest.spyOn(combat, 'readRecord').mockRejectedValue(new Error('Combat caído'))
    const list = await new ListTournamentMatches(
      f.encounters,
      new PersistedBracketEncounterSource(f.repo),
      combat,
    ).execute(t.id)
    expect(list).toHaveLength(14)
    expect(list.find((x) => x.encounterId === record.encounterId)).toMatchObject({
      status: 'IN_PROGRESS',
      closedAt: null,
      result: null,
      lastSyncedSeq: 1,
    })
  })
  it('proyección tardía no revierte cierre, ganador, cursor ni roster', async () => {
    const { f, t, seed } = await setup()
    const finished = {
      ...seed,
      status: 'FINISHED' as const,
      lastSyncedSeq: 4,
      logComplete: true,
      closedAt: new Date('2026-10-05T12:10:00Z'),
      result: {
        winnerTeamLabel: 'RED',
        reason: 'TIME_LIMIT',
        outcome: 'WIN',
        finishedAt: new Date('2026-10-05T12:10:00Z'),
      },
    }
    await f.encounters.save(finished)
    await f.encounters.save(seed)
    expect(await f.encounters.findOne(t.id, seed.encounterId)).toMatchObject({
      status: 'FINISHED',
      lastSyncedSeq: 4,
      result: { winnerTeamLabel: 'RED' },
      logComplete: true,
    })
    expect(() => mergeArchivedEncounter(finished, { ...seed, round: 2 })).toThrow('identidad')
    expect(
      mergeArchivedEncounter({ ...seed, status: 'IN_PROGRESS' }, { ...seed, status: 'READY' })
        .status,
    ).toBe('IN_PROGRESS')
    expect(mergeArchivedEncounter({ ...seed, status: 'READY' }, seed).status).toBe('READY')
  })
  it('reconciliadores sincronizan sin navegador, toleran caída y se pueden detener', async () => {
    const { f, combat } = await setup()
    const sync = new CombatRecordReconciler(f.encounters, combat)
    await sync.sweep()
    const broken = jest
      .spyOn(f.encounters, 'findLinked')
      .mockRejectedValueOnce(new Error('DB caída'))
    await expect(sync.sweep()).rejects.toThrow('DB caída')
    broken.mockRestore()
    sync.onModuleInit()
    await sync.sweep()
    sync.onModuleDestroy()
    const entries = new RegistrationReconciler(f.registrations)
    entries.onModuleInit()
    entries.onModuleDestroy()
    expect(await f.registrations.list()).toHaveLength(1)
  })
})
