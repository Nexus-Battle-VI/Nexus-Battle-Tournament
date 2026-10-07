import type { Kysely } from 'kysely'

import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import { PostgresRegistrationRepository } from '../../src/adapters/outbound/persistence/PostgresRegistrationRepository'
import { PostgresTournamentEncounterRepository } from '../../src/adapters/outbound/persistence/PostgresTournamentEncounterRepository'
import { PostgresEncounterAdminStore } from '../../src/adapters/outbound/persistence/PostgresEncounterAdminStore'
import { PersistedBracketEncounterSource } from '../../src/adapters/outbound/bracket/PersistedBracketEncounterSource'
import { EncounterAdministration } from '../../src/application/use-cases/EncounterAdministration'
import { fixture, FREE_POLICY } from '../support/registration-fixture'
import { FakeCombat } from '../support/fake-combat'
import { startTestPostgres } from '../support/postgres'

/**
 * HU-85 sobre PostgreSQL real aislado: recibos durables, unicidad impuesta por
 * el motor y dos instancias del servicio compitiendo por la misma justa. Combat
 * es un doble de prueba (ver `fake-combat.ts`).
 */
// Docker en Windows puede tardar al levantar cada contenedor: margen amplio contra falsos timeouts.
jest.setTimeout(240_000)

describe('HU-85 en PostgreSQL real aislado', () => {
  let runtime: Awaited<ReturnType<typeof startTestPostgres>>
  let db: Kysely<Database>
  beforeEach(async () => {
    runtime = await startTestPostgres()
    db = createDatabase({ connectionString: runtime.connectionString })
    const result = await migrateToLatest(db)
    if (result.error !== undefined) throw new Error('Falló la migración.')
  }, 240000)
  afterEach(async () => {
    await db.destroy()
    await runtime.stop()
  })

  const setup = async () => {
    const f = fixture(new PostgresRegistrationRepository(db), FREE_POLICY)
    const t = await f.create()
    for (let n = 0; n < 8; n += 1) await f.confirm(t.id, n)
    await f.brackets.publish(t.id, 'admin', 'pub')
    const combat = new FakeCombat()
    const encounters = new PostgresTournamentEncounterRepository(db)
    const instance = () =>
      new EncounterAdministration(
        encounters,
        new PersistedBracketEncounterSource(f.repo),
        combat,
        combat,
        new PostgresEncounterAdminStore(db),
        f.clock,
        (id) => f.brackets.view(id),
      )
    return { f, t, combat, encounters, instance }
  }

  it('prepara e inicia y persiste estado y recibos que sobreviven a reconstruir los adaptadores', async () => {
    const { t, combat, encounters, instance } = await setup()
    const prepared = await instance().prepare(t.id, `${t.id}:E1`, 'admin', 'prep-e1')
    const started = await instance().start(t.id, `${t.id}:E1`, 'admin', 'start-e1')
    expect(prepared).toMatchObject({ action: 'PREPARE', replayed: false, status: 'READY' })
    expect(started).toMatchObject({
      action: 'START',
      battleId: prepared.battleId,
      status: 'IN_PROGRESS',
      preparationStatus: 'IN_BATTLE',
    })
    expect(await encounters.findOne(t.id, `${t.id}:E1`)).toMatchObject({
      status: 'IN_PROGRESS',
      combatRoomId: prepared.battleId,
      startedAt: new Date('2026-10-12T15:00:00Z'),
    })
    const listed = await instance().list(t.id)
    expect(listed.map((r) => [r.action, r.actor, r.battleId])).toEqual([
      ['PREPARE', 'admin', prepared.battleId],
      ['START', 'admin', prepared.battleId],
    ])
    expect(combat.startedRooms).toBe(1)
  })

  it('dos instancias concurrentes sobre la misma justa dejan una sala y un recibo por acción', async () => {
    const { t, combat, instance } = await setup()
    const [a, b] = await Promise.all([
      instance().prepare(t.id, `${t.id}:E1`, 'admin', 'prep-a'),
      instance().prepare(t.id, `${t.id}:E1`, 'admin2', 'prep-b'),
    ])
    expect(a.battleId).toBe(b.battleId)
    expect(combat.rooms.size).toBe(1)
    const [s1, s2] = await Promise.all([
      instance().start(t.id, `${t.id}:E1`, 'admin', 'start-a'),
      instance().start(t.id, `${t.id}:E1`, 'admin2', 'start-b'),
    ])
    expect(s1.actionId).toBe(s2.actionId)
    expect(combat.startedRooms).toBe(1)
    const rows = await db
      .selectFrom('tournament_encounter_actions')
      .selectAll()
      .where('tournament_id', '=', t.id)
      .execute()
    expect(rows.map((r) => r.action).sort()).toEqual(['PREPARE', 'START'])
  })

  it('E1 y E2 independientes en paralelo; E5 sin participantes se rechaza sin tocar nada', async () => {
    const { t, combat, encounters, instance } = await setup()
    const [e1, e2] = await Promise.all([
      instance().prepare(t.id, `${t.id}:E1`, 'admin', 'prep-e1'),
      instance().prepare(t.id, `${t.id}:E2`, 'admin', 'prep-e2'),
    ])
    expect(e1.battleId).not.toBe(e2.battleId)
    await expect(instance().prepare(t.id, `${t.id}:E5`, 'admin', 'prep-e5')).rejects.toMatchObject({
      code: 'PARTICIPANTS_UNRESOLVED',
      status: 409,
    })
    expect(await encounters.findOne(t.id, `${t.id}:E5`)).toMatchObject({
      status: 'WAITING_PARTICIPANTS',
      combatRoomId: null,
      teams: [],
      result: null,
    })
    expect(combat.rooms.size).toBe(2)
  })

  it('la base impide duplicar recibos, operaciones o acciones inválidas', async () => {
    const { t, instance } = await setup()
    const prepared = await instance().prepare(t.id, `${t.id}:E1`, 'admin', 'prep-e1')
    const row = {
      action_id: '00000000-0000-4000-8000-000000000099',
      tournament_id: t.id,
      encounter_id: `${t.id}:E1`,
      action: 'PREPARE' as const,
      actor: 'otro',
      operation_id: 'otra',
      combat_room_id: 'room',
      occurred_at: new Date(),
    }
    await expect(
      db.insertInto('tournament_encounter_actions').values(row).execute(),
    ).rejects.toMatchObject({
      code: '23505',
    })
    await expect(
      db
        .insertInto('tournament_encounter_actions')
        .values({ ...row, action: 'START', operation_id: 'prep-e1' })
        .execute(),
    ).rejects.toMatchObject({ code: '23505' })
    await expect(
      db
        .insertInto('tournament_encounter_actions')
        .values({ ...row, action: 'CANCEL' as 'START', operation_id: 'z' })
        .execute(),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      db
        .insertInto('tournament_encounter_actions')
        .values({ ...row, encounter_id: `${t.id}:E99`, action: 'START', operation_id: 'y' })
        .execute(),
    ).rejects.toMatchObject({ code: '23503' })
    expect(await instance().list(t.id)).toHaveLength(1)
    expect(prepared.operationId).toBe('prep-e1')
  })
})
