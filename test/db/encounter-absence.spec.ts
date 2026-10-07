import type { Kysely } from 'kysely'

import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import { PostgresRegistrationRepository } from '../../src/adapters/outbound/persistence/PostgresRegistrationRepository'
import { PostgresTournamentEncounterRepository } from '../../src/adapters/outbound/persistence/PostgresTournamentEncounterRepository'
import { PostgresAbsenceStore } from '../../src/adapters/outbound/persistence/PostgresAbsenceStore'
import { PersistedBracketEncounterSource } from '../../src/adapters/outbound/bracket/PersistedBracketEncounterSource'
import { EncounterAbsences } from '../../src/application/use-cases/EncounterAbsences'
import { fixture, FREE_POLICY } from '../support/registration-fixture'
import { FakeCombat } from '../support/fake-combat'
import { startTestPostgres } from '../support/postgres'

/**
 * Decisión de Carlos sobre HU-85 en PostgreSQL real aislado: aceptaciones
 * durables, una sola resolución por justa aunque dos instancias barran a la vez
 * y recuperación si el proceso cae entre guardar la resolución y cerrar la justa.
 */
jest.setTimeout(240_000)

describe('HU-85: ventana de aceptación y ausencia en PostgreSQL real aislado', () => {
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
    const store = new PostgresAbsenceStore(db)
    const instance = (random = () => 0.1) =>
      new EncounterAbsences(
        encounters,
        new PersistedBracketEncounterSource(f.repo),
        combat,
        store,
        f.clock,
        f.repo,
        random,
      )
    return { f, t, encounters, store, instance }
  }

  it('guarda aceptaciones sin duplicar y resuelve la ausencia una sola vez entre dos instancias', async () => {
    const { f, t, encounters, store, instance } = await setup()
    f.setNow('2026-10-12T00:01:00Z')
    await instance().accept(t.id, `${t.id}:E1`, 'p0')
    await instance().accept(t.id, `${t.id}:E1`, 'p0')
    await instance().accept(t.id, `${t.id}:E1`, 'q0')
    expect(await store.listReady(t.id, `${t.id}:E1`)).toHaveLength(2)
    f.setNow('2026-10-12T00:03:00Z')
    const [a, b] = await Promise.all([instance().sweep(), instance().sweep()])
    expect(a + b).toBeGreaterThanOrEqual(4)
    const e1 = await encounters.findOne(t.id, `${t.id}:E1`)
    expect(e1).toMatchObject({
      status: 'FINISHED',
      combatRoomId: null,
      result: { reason: 'ABSENCE', outcome: 'WIN' },
    })
    const rows = await db
      .selectFrom('tournament_encounter_absences')
      .select(['encounter_id', 'kind', 'winner_team_id'])
      .where('tournament_id', '=', t.id)
      .execute()
    expect(rows).toHaveLength(4)
    expect(rows.find((r) => r.encounter_id === `${t.id}:E1`)?.kind).toBe('ONE_TEAM_READY')
    expect(await instance().sweep()).toBe(0)
    expect((await encounters.findOne(t.id, `${t.id}:E5`))?.status).toBe('WAITING_PARTICIPANTS')
  })

  it('si cae entre guardar la resolución y cerrar la justa, el siguiente barrido la completa con el mismo ganador', async () => {
    const { f, t, encounters, store, instance } = await setup()
    f.setNow('2026-10-12T00:03:00Z')
    const first = await encounters.findOne(t.id, `${t.id}:E2`)
    const teams = first?.bracketMetadata?.registeredTeams ?? []
    const loser = teams[0]
    const winner = teams[1]
    if (!loser || !winner) throw new Error('E2 debe tener equipos resueltos')
    await store.saveResolution({
      tournamentId: t.id,
      encounterId: `${t.id}:E2`,
      winnerTeamId: winner.teamId,
      kind: 'DRAW',
      readyCounts: [0, 0],
      resolvedAt: new Date('2026-10-12T00:02:30Z'),
    })
    expect((await encounters.findOne(t.id, `${t.id}:E2`))?.status).not.toBe('FINISHED')
    // El sorteo de este barrido daría el otro equipo (0.1 -> primero), pero manda la resolución guardada.
    await instance(() => 0.1).sweep()
    expect(await encounters.findOne(t.id, `${t.id}:E2`)).toMatchObject({
      status: 'FINISHED',
      result: { winnerTeamLabel: winner.teamId, reason: 'ABSENCE' },
    })
  })

  it('la base impide duplicar resoluciones, aceptar dos veces o resolver una justa inexistente', async () => {
    const { f, t, store } = await setup()
    f.setNow('2026-10-12T00:03:00Z')
    const row = {
      tournament_id: t.id,
      encounter_id: `${t.id}:E1`,
      winner_team_id: 'x',
      kind: 'DRAW' as const,
      ready_counts: '[0,0]',
      resolved_at: new Date(),
    }
    await db.insertInto('tournament_encounter_absences').values(row).execute()
    await expect(
      db.insertInto('tournament_encounter_absences').values(row).execute(),
    ).rejects.toMatchObject({ code: '23505' })
    await expect(
      db
        .insertInto('tournament_encounter_absences')
        .values({ ...row, encounter_id: `${t.id}:E2`, kind: 'COIN' as 'DRAW' })
        .execute(),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      db
        .insertInto('tournament_encounter_readiness')
        .values({
          tournament_id: t.id,
          encounter_id: `${t.id}:E99`,
          player_id: 'p0',
          accepted_at: new Date(),
        })
        .execute(),
    ).rejects.toMatchObject({ code: '23503' })
    const again = await store.saveResolution({
      tournamentId: t.id,
      encounterId: `${t.id}:E1`,
      winnerTeamId: 'otro',
      kind: 'ONE_TEAM_READY',
      readyCounts: [2, 0],
      resolvedAt: new Date(),
    })
    expect(again.winnerTeamId).toBe('x')
  })
})
