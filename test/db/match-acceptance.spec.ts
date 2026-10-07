import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { startTestPostgres } from '../support/postgres'
import { acceptanceFixture } from '../support/acceptance-fixture'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import { PostgresRegistrationRepository } from '../../src/adapters/outbound/persistence/PostgresRegistrationRepository'
import { PostgresTournamentEncounterRepository } from '../../src/adapters/outbound/persistence/PostgresTournamentEncounterRepository'
import { PostgresLifecycleRepository } from '../../src/adapters/outbound/persistence/PostgresLifecycleRepository'
import { PostgresMatchAcceptanceStore } from '../../src/adapters/outbound/persistence/PostgresMatchAcceptanceStore'
import { PostgresEncounterAdminStore } from '../../src/adapters/outbound/persistence/PostgresEncounterAdminStore'
import { MatchAcceptance } from '../../src/application/use-cases/MatchAcceptance'
import { AcceptanceReconciliation } from '../../src/application/use-cases/AcceptanceReconciliation'
import { Progressions } from '../../src/application/use-cases/Progressions'
import { EncounterAdministration } from '../../src/application/use-cases/EncounterAdministration'
import { PersistedBracketEncounterSource } from '../../src/adapters/outbound/bracket/PersistedBracketEncounterSource'
import { Prizes } from '../../src/application/use-cases/Prizes'
import type { Database } from '../../src/adapters/outbound/persistence/schema'

describe('Aceptación, ausencias y worker con PostgreSQL real y dos pools', () => {
  let server: Awaited<ReturnType<typeof startTestPostgres>>,
    db: Kysely<Database>,
    second: Kysely<Database>
  beforeEach(async () => {
    server = await startTestPostgres()
    db = createDatabase({ connectionString: server.connectionString })
    second = createDatabase({ connectionString: server.connectionString })
    expect((await migrateToLatest(db)).error).toBeUndefined()
  })
  afterEach(async () => {
    await Promise.all([db.destroy(), second.destroy()])
    await server.stop()
  })
  const setup = () =>
    acceptanceFixture({
      registrations: new PostgresRegistrationRepository(db),
      encounters: new PostgresTournamentEncounterRepository(db),
      lifecycle: new PostgresLifecycleRepository(db),
      acceptance: new PostgresMatchAcceptanceStore(db),
      actions: new PostgresEncounterAdminStore(db),
    })
  const reborn = (f: Awaited<ReturnType<typeof setup>>) => {
    const repo = new PostgresRegistrationRepository(second),
      store = new PostgresMatchAcceptanceStore(second),
      archive = new PostgresTournamentEncounterRepository(second),
      actions = new PostgresEncounterAdminStore(second),
      lifecycle = new PostgresLifecycleRepository(second)
    const progress = new Progressions(lifecycle, repo, f.source, f.clock, archive, store)
    const random = { bit: jest.fn<0 | 1, []>(() => 1) }
    const acceptance = new MatchAcceptance(store, repo, progress, f.clock, random)
    const admin = new EncounterAdministration(
      archive,
      new PersistedBracketEncounterSource(repo),
      f.record,
      f.commands,
      actions,
      f.clock,
      (id) => f.brackets.view(id),
      (id, e) => acceptance.guard(id, e),
    )
    return {
      store,
      progress,
      random,
      acceptance,
      worker: new AcceptanceReconciliation(repo, acceptance, admin, progress),
    }
  }
  it('dos pools confirman un sujeto una sola vez; operación ajena y cierre exacto no cambian el conteo', async () => {
    const f = await setup(),
      other = reborn(f),
      e = f.e().encounterId,
      subject = f.b.seeds[0]!.memberIds[0]!
    f.setOpen()
    const [a, b] = await Promise.all([
      f.acceptance.accept(f.id, e, subject, 'same'),
      other.acceptance.accept(f.id, e, subject, 'same'),
    ])
    expect(a.receiptId).toBe(b.receiptId)
    expect([a.replayed, b.replayed].sort()).toEqual([false, true])
    const alias = await other.acceptance.accept(f.id, e, subject, 'alias')
    expect(alias.receiptId).toBe(a.receiptId)
    await expect(
      other.acceptance.accept(f.id, f.e('E2').encounterId, f.b.seeds[2]!.memberIds[0]!, 'alias'),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
    f.setClose()
    const race = await Promise.allSettled([
      other.acceptance.accept(f.id, e, f.b.seeds[1]!.memberIds[0]!, 'deadline'),
      f.reconciliation.run(f.id, e),
    ])
    expect(race[0]).toMatchObject({ status: 'rejected', reason: { code: 'ACCEPTANCE_CLOSED' } })
    expect(race[1].status).toBe('fulfilled')
    const state = await other.store.read(f.id, e)
    expect(state!.resolution!.acceptedCounts).toEqual([1, 0])
    expect(await db.selectFrom('tournament_acceptances').selectAll().execute()).toHaveLength(1)
    expect(
      await db.selectFrom('tournament_acceptance_operations').selectAll().execute(),
    ).toHaveLength(2)
    expect(await other.acceptance.accept(f.id, e, subject, 'same')).toEqual({
      ...a,
      replayed: true,
    })
  })
  it('dos cierres y un reinicio guardan un solo sorteo y una sola victoria; SQL protege la decisión', async () => {
    const f = await setup(),
      other = reborn(f),
      e = f.e().encounterId
    f.setOpen()
    await f.acceptance.decide(f.id, e)
    f.setClose()
    await Promise.all([f.reconciliation.run(f.id, e), other.worker.run(f.id, e)])
    expect(f.random.bit.mock.calls.length + other.random.bit.mock.calls.length).toBe(1)
    const state = await f.store.read(f.id, e)
    expect((await f.lifecycle.read(f.id)).results).toHaveLength(1)
    await reborn(f).worker.run(f.id, e)
    expect(await f.store.read(f.id, e)).toEqual(state)
    expect(await db.selectFrom('tournament_resolutions').selectAll().execute()).toHaveLength(1)
    const changedBit = state!.resolution!.coinBit === 0 ? '1' : '0'
    await expect(
      sql`UPDATE tournament_match_acceptance SET data=jsonb_set(data,'{resolution,coinBit}',${changedBit}::jsonb) WHERE tournament_id=${f.id} AND encounter_id=${e}`.execute(
        db,
      ),
    ).rejects.toThrow('IMMUTABLE_TOURNAMENT_DECISION')
    await expect(
      sql`UPDATE tournaments SET round_windows='[]'::jsonb WHERE id=${f.id}`.execute(db),
    ).rejects.toThrow('IMMUTABLE_TOURNAMENT_SCHEDULE')
    await expect(
      sql`UPDATE tournament_encounters SET bracket_metadata=bracket_metadata-'acceptancePolicy' WHERE tournament_id=${f.id} AND encounter_id=${e}`.execute(
        db,
      ),
    ).rejects.toThrow('IMMUTABLE_ENCOUNTER_ACCEPTANCE_POLICY')
    const archive = await f.encounters.findOne(f.id, e)
    expect(archive).toMatchObject({ combatRoomId: null, result: null, teams: [], startedAt: null })
    expect((await f.encounters.listEvents(f.id, e, 0, 100)).events).toEqual([])
  })
  it('preparación y respuesta de inicio perdida recuperan sala e IDs tras reinicio; dos workers dejan una auditoría', async () => {
    const f = await setup(),
      other = reborn(f),
      e = f.e().encounterId
    f.setOpen()
    await f.acceptSide()
    await f.acceptSide('E1', 1)
    f.setClose()
    f.commands.startRoom.mockRejectedValueOnce(new Error('Respuesta perdida tras iniciar'))
    await f.reconciliation.run(f.id, e)
    const pending = await other.store.read(f.id, e)
    expect(pending).toMatchObject({
      decision: 'COMBAT',
      resolution: null,
      combatIntent: { phase: 'START_PENDING', roomId: 'room-' + e },
      blocker: { responsible: 'COMBAT_OPERATIONS' },
    })
    await Promise.all([other.worker.run(f.id, e), reborn(f).worker.run(f.id, e)])
    expect(f.commands.createRoom).toHaveBeenCalledTimes(1)
    expect(f.commands.startRoom).toHaveBeenCalledTimes(2)
    expect(new Set(f.commands.startRoom.mock.calls.map((c) => c[1].operationId)).size).toBe(1)
    expect(await f.actions.list(f.id)).toHaveLength(2)
    expect((await other.store.read(f.id, e))!.combatIntent!.phase).toBe('STARTED')
    expect((await f.lifecycle.read(f.id)).results).toEqual([])
  })
  it('ventana perdida y dependencia retrasada quedan bloqueadas en persistencia sin sorteo', async () => {
    const f = await setup(),
      other = reborn(f)
    f.setClose()
    await f.reconciliation.run(f.id, f.e().encounterId)
    f.setOpen(2)
    await other.worker.run(f.id, f.e('E5').encounterId)
    f.setClose(2)
    await reborn(f).worker.run(f.id, f.e('E5').encounterId)
    expect((await f.store.read(f.id, f.e().encounterId))!.blocker!.code).toBe('WINDOW_MISSED')
    expect((await other.store.read(f.id, f.e('E5').encounterId))!.blocker!.code).toBe(
      'DEPENDENCIES_DELAYED',
    )
    expect(await f.store.resolutions(f.id)).toEqual([])
    expect(f.random.bit).not.toHaveBeenCalled()
    expect(other.random.bit).not.toHaveBeenCalled()
  })
  it('caída durante la ventana mantiene recibos al reiniciar, sin derrota inferida de la incidencia', async () => {
    const f = await setup(),
      e = f.e().encounterId
    f.setOpen()
    await f.acceptSide('E1', 0, 2)
    const write = f.store.change.bind(f.store)
    jest
      .spyOn(f.store, 'change')
      .mockImplementationOnce(write)
      .mockRejectedValueOnce(new Error('Escritura interrumpida'))
    await expect(
      f.acceptance.accept(f.id, e, f.b.seeds[1]!.memberIds[0]!, 'interrupted'),
    ).rejects.toThrow('Escritura interrumpida')
    f.setNow(f.window().acceptanceClosesAt)
    await reborn(f).worker.run(f.id, e)
    expect(await f.store.read(f.id, e)).toMatchObject({
      phase: 'BLOCKED',
      decision: null,
      resolution: null,
      blocker: { code: 'ACCEPTANCE_SERVICE_INTERRUPTED' },
    })
    expect((await f.store.read(f.id, e))!.acceptances).toHaveLength(2)
    expect((await reborn(f).store.read(f.id, e))!.pendingAcceptances).toHaveLength(1)
    expect(await f.store.resolutions(f.id)).toEqual([])
    expect((await f.lifecycle.read(f.id)).results).toEqual([])
  })
  it('pausa del worker conserva 3–0 y 0–0; SQL no exige ticks para una ausencia', async () => {
    const f = await setup(),
      other = reborn(f),
      e = f.e().encounterId,
      empty = f.e('E2').encounterId
    f.setOpen()
    await f.acceptSide('E1', 0, 3)
    await f.acceptance.decide(f.id, empty)
    f.setClose()
    await Promise.all([other.worker.run(f.id, e), other.worker.run(f.id, empty)])
    expect(await other.store.read(f.id, e)).toMatchObject({
      phase: 'CLOSED',
      decision: 'TOURNAMENT',
      blocker: null,
      resolution: {
        rule: 'COMPLETE_TEAM',
        acceptedCounts: [3, 0],
        winnerTeamId: f.b.seeds[0]!.teamId,
      },
    })
    expect(await other.store.read(f.id, empty)).toMatchObject({
      phase: 'CLOSED',
      decision: 'TOURNAMENT',
      blocker: null,
      resolution: { rule: 'FAIR_COIN', acceptedCounts: [0, 0], coinBit: 1 },
    })
    expect(other.random.bit).toHaveBeenCalledTimes(1)
    expect(f.commands.createRoom).not.toHaveBeenCalled()
  })
  it('Final por ausencia conserva campeón TRIO, 14 victorias únicas y derechos pendientes recuperables', async () => {
    const f = await setup()
    for (let round = 1; round <= 6; round++) {
      f.setOpen(round)
      await f.reconciliation.sweep()
      f.setClose(round)
      await f.reconciliation.sweep()
    }
    const state = await f.lifecycle.read(f.id)
    expect(state.champion).toMatchObject({
      memberIds: expect.any(Array),
      finalRoomId: null,
      heroes: [],
    })
    expect(state.champion!.memberIds).toHaveLength(3)
    expect(state.results).toHaveLength(14)
    const grant = jest.fn(),
      heroFor = jest.fn(() => Promise.resolve(null as string | null))
    const prizes = new Prizes(f.lifecycle, f.repo, { grant }, f.clock, { heroFor })
    await prizes.approve(f.id, 'admin', {
      operationId: 'award',
      allocations: [
        { memberIndex: 0, credits: '10', epicProductId: 'epic' },
        { memberIndex: 1, credits: '10', epicProductId: null },
        { memberIndex: 2, credits: '10', epicProductId: null },
      ],
    })
    await prizes.deliver(f.id, 'admin')
    const pending = (await prizes.view(f.id)).delivery!
    expect(pending.lines).toHaveLength(4)
    heroFor.mockResolvedValue('validated-owned-hero')
    await prizes.reconcile()
    const recovered = (await prizes.view(f.id)).delivery!
    expect(recovered.lines.map((l) => l.operationId)).toEqual(
      pending.lines.map((l) => l.operationId),
    )
    expect(recovered.lines.every((l) => l.lastError === 'PRIZE_RESOLUTION_CONTRACT_REQUIRED')).toBe(
      true,
    )
    expect(grant).not.toHaveBeenCalled()
    await reborn(f).worker.sweep()
    expect((await f.lifecycle.read(f.id)).results).toHaveLength(14)
    expect((await f.progress.view(f.id)).statistics.reduce((n, s) => n + s.victories, 0)).toBe(14)
    expect((await f.repo.read(f.id)).bracket).toEqual(f.b)
  }, 30000)
})
