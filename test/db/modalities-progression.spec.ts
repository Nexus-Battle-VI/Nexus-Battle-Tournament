import { sql, type Kysely } from 'kysely'
import { randomUUID } from 'node:crypto'
import { startTestPostgres } from '../support/postgres'
import { modeFixture } from '../support/modalities-fixture'
import { fixture, FREE_POLICY, CREDIT_POLICY } from '../support/registration-fixture'
import { matchFixture, storedFixture, ControlledMatchRead } from '../support/match-read-fixture'
import {
  createDatabase,
  migrateToLatest,
  MIGRATIONS,
} from '../../src/infrastructure/persistence/database'
import { PostgresRegistrationRepository } from '../../src/adapters/outbound/persistence/PostgresRegistrationRepository'
import { PostgresTournamentEncounterRepository } from '../../src/adapters/outbound/persistence/PostgresTournamentEncounterRepository'
import { PostgresLifecycleRepository } from '../../src/adapters/outbound/persistence/PostgresLifecycleRepository'
import { Progressions } from '../../src/application/use-cases/Progressions'
import { Prizes } from '../../src/application/use-cases/Prizes'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import type { TournamentMode } from '../../src/domain/registration'
import type { PrizeGrant } from '../../src/domain/prize'

describe('Modalidades y avance con PostgreSQL real, pools independientes y upgrade', () => {
  let server: Awaited<ReturnType<typeof startTestPostgres>>, db: Kysely<Database>
  beforeEach(async () => {
    server = await startTestPostgres()
    db = createDatabase({ connectionString: server.connectionString })
  })
  afterEach(async () => {
    await db.destroy()
    await server.stop()
  })
  const migrate = async () => {
    expect((await migrateToLatest(db)).error).toBeUndefined()
  }
  it.each(['SOLO', 'DUO', 'TRIO'] as TournamentMode[])(
    'publicación SQL %s exige tamaño exacto y no modifica configuración',
    async (mode) => {
      await migrate()
      const f = await modeFixture(mode, new PostgresRegistrationRepository(db)),
        b = await f.publish()
      expect(b.seeds.flatMap((s) => s.memberIds)).toHaveLength(8 * f.t.teamSize)
      expect(
        await new PostgresTournamentEncounterRepository(db).findAllByTournament(f.id),
      ).toHaveLength(14)
      await expect(
        sql`UPDATE tournaments SET team_size=1,tournament_mode='SOLO',starts_at=starts_at+interval '1 minute' WHERE id=${f.id}`.execute(
          db,
        ),
      ).rejects.toThrow('IMMUTABLE_TOURNAMENT_CONFIGURATION')
      await expect(
        db.updateTable('tournaments').set({ bracket: '{}' }).where('id', '=', f.id).execute(),
      ).rejects.toThrow('IMMUTABLE_BRACKET')
    },
  )
  it('dos equipos compiten por una persona y dos pools por el último cupo; solo un cobro', async () => {
    await migrate()
    const f = await modeFixture('TRIO', new PostgresRegistrationRepository(db), CREDIT_POLICY)
    const race = (owner: string) =>
      f.registrations.register(f.id, owner, {
        operationId: 'r' + owner,
        name: 'Carrera',
        invitedMemberIds: ['shared', owner + 'x'],
        avatar: { kind: 'ACCOUNT_AVATAR', subject: owner },
      })
    const raced = await Promise.allSettled([race('one'), race('two')])
    expect(raced.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    const winner = raced.find((x) => x.status === 'fulfilled')!
    await f.registrations.cancel(f.id, winner.value.id, winner.value.ownerId, 'cancel')
    for (let n = 0; n < 7; n++) await f.modeConfirm(n)
    const [a, b] = await Promise.all([f.modeRegister(7), f.modeRegister(8)])
    const second = createDatabase({ connectionString: server.connectionString })
    try {
      const alternate = fixture(new PostgresRegistrationRepository(second), CREDIT_POLICY)
      // Mismo gateway controlado para contabilizar todos los cobros de los dos pools.
      const { Registrations } = await import('../../src/application/use-cases/Registrations')
      const r = new Registrations(alternate.repo, f.accounts, f.wallet, f.clock, f.simulator)
      const outcomes = await Promise.allSettled([
        f.registrations.enter(f.id, a.id, a.ownerId, { operationId: 'last-a' }),
        r.enter(f.id, b.id, b.ownerId, { operationId: 'last-b' }),
      ])
      expect(outcomes.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
      expect(f.wallet.debits).toBe(8)
      expect((await f.registrations.view(f.id, a.ownerId)).capacity.available).toBe(0)
    } finally {
      await second.destroy()
    }
  })
  it('upgrade desde 001–004 conserva recibos, huellas, snapshot, archivo y auditoría', async () => {
    const published = Object.fromEntries(Object.entries(MIGRATIONS).filter(([key]) => key < '006'))
    expect((await migrateToLatest(db, published)).error).toBeUndefined()
    const f = fixture(undefined, FREE_POLICY),
      t = await f.create()
    for (let n = 0; n < 8; n++) await f.confirm(t.id, n)
    const b = await f.brackets.publish(t.id, 'admin', 'publish'),
      state = await f.repo.read(t.id)
    await db
      .insertInto('tournaments')
      .values({
        id: t.id,
        name: t.name,
        entry_policy: JSON.stringify(FREE_POLICY),
        entry_fee: 0,
        opens_at: new Date(t.opensAt),
        closes_at: new Date(t.closesAt),
        starts_at: new Date(t.startsAt),
        starts_epoch: new Date(t.startsAt).getTime(),
      })
      .execute()
    for (const team of state.teams) {
      const old = { ...team }
      delete old.members
      await db
        .insertInto('registration_teams')
        .values({
          id: team.id,
          tournament_id: t.id,
          owner_id: team.ownerId,
          companion_id: team.companionId,
          status: team.status,
          slot: team.slot,
          data: JSON.stringify(old),
        })
        .execute()
      await db
        .insertInto('registration_members')
        .values(
          team.registrationReceipt.memberIds.map((player_id) => ({
            tournament_id: t.id,
            team_id: team.id,
            player_id,
          })),
        )
        .execute()
    }
    await db
      .insertInto('tournament_admin_operations')
      .values({
        operation_id: 'create',
        tournament_id: t.id,
        intent: JSON.stringify([
          'create',
          'admin',
          t.name,
          FREE_POLICY,
          t.opensAt,
          t.closesAt,
          t.startsAt,
        ]),
      })
      .execute()
    for (const [operation_id, op] of Object.entries(state.operations))
      await db
        .insertInto('registration_operations')
        .values({
          tournament_id: t.id,
          operation_id,
          intent: op.intent,
          team_id: op.teamId,
          data: JSON.stringify(op),
        })
        .execute()
    await db
      .updateTable('tournaments')
      .set({ bracket: JSON.stringify(b) })
      .where('id', '=', t.id)
      .execute()
    const archive = new PostgresTournamentEncounterRepository(db),
      e = matchFixture(b)
    await archive.save(storedFixture(e, b))
    await archive.appendEvents(e.events)
    await db
      .insertInto('tournament_encounter_actions')
      .values({
        action_id: randomUUID(),
        tournament_id: t.id,
        encounter_id: e.encounterId,
        action: 'START',
        actor: 'admin',
        operation_id: 'start',
        combat_room_id: e.combatRoomId!,
        occurred_at: new Date(e.startedAt!),
      })
      .execute()
    const before = await archive.findOne(t.id, e.encounterId)
    expect((await migrateToLatest(db)).error).toBeUndefined()
    const repo = new PostgresRegistrationRepository(db),
      migrated = await repo.read(t.id)
    expect(migrated.tournamentMode).toBe('DUO')
    expect(migrated.bracket).toEqual(b)
    expect(migrated.operations).toEqual(state.operations)
    expect(migrated.teams.map((s) => s.entryReceipt)).toEqual(
      state.teams.sort((a, c) => a.id.localeCompare(c.id)).map((s) => s.entryReceipt),
    )
    expect(migrated.teams.every((s) => s.members!.length === 2)).toBe(true)
    expect(await archive.findOne(t.id, e.encounterId)).toEqual(before)
    expect((await archive.listEvents(t.id, e.encounterId, 0, 200)).events).toHaveLength(120)
    const replay = fixture(repo, FREE_POLICY)
    expect((await replay.create()).id).toBe(t.id)
    expect((await replay.register(t.id)).registrationReceipt).toEqual(
      state.teams.find((s) => s.ownerId === 'p0')!.registrationReceipt,
    )
  })
  it('TRIO confirma archivo oficial, recupera campeón y derechos una vez; SQL rechaza reescritura', async () => {
    await migrate()
    const f = await modeFixture('TRIO', new PostgresRegistrationRepository(db)),
      b = await f.publish()
    const lifecycle = new PostgresLifecycleRepository(db),
      source = new ControlledMatchRead(),
      archive = new PostgresTournamentEncounterRepository(db)
    const progress = new Progressions(lifecycle, f.repo, source, f.clock, archive)
    for (const m of b.matches) {
      const e = matchFixture(b, m.id, (await lifecycle.read(f.id)).results)
      await archive.save(storedFixture(e, b))
      await archive.appendEvents(e.events)
      source.items.set(e.encounterId, e)
      await progress.confirm(f.id, e.encounterId)
    }
    const state = await lifecycle.read(f.id)
    expect(state.champion!.memberIds).toHaveLength(3)
    await progress.reconcile()
    expect(await lifecycle.read(f.id)).toEqual(state)
    const grant = jest.fn((c: PrizeGrant) =>
      Promise.resolve({ ...c, status: 'DELIVERED', receiptId: 'receipt:' + c.operationId }),
    )
    const prizes = new Prizes(lifecycle, f.repo, { grant }, f.clock)
    await prizes.approve(f.id, 'admin', {
      operationId: 'award',
      allocations: [
        { memberIndex: 0, credits: '501', epicProductId: 'epic' },
        { memberIndex: 1, credits: '300', epicProductId: null },
        { memberIndex: 2, credits: '199', epicProductId: null },
      ],
    })
    expect((await prizes.deliver(f.id, 'admin')).delivery!.status).toBe('COMPLETED')
    await prizes.reconcile()
    expect(grant).toHaveBeenCalledTimes(4)
    await expect(
      lifecycle.change(f.id, (s) => {
        s.results[0]!.winnerTeamId = 'foreign'
      }),
    ).rejects.toThrow('complete official HU83 archive')
    expect(await lifecycle.pendingDeliveries()).toEqual([])
    await expect(lifecycle.change('missing', () => null)).rejects.toMatchObject({ status: 404 })
  })
  it('sin upgrade de lifecycle falla cerrado; derechos pendientes conservan error y responsable', async () => {
    expect(
      (
        await migrateToLatest(
          db,
          Object.fromEntries(Object.entries(MIGRATIONS).filter(([key]) => key < '006')),
        )
      ).error,
    ).toBeUndefined()
    const r = new PostgresLifecycleRepository(db)
    for (const work of [
      () => r.read('missing'),
      () => r.change('missing', () => null),
      () => r.pendingDeliveries(),
    ])
      await expect(work()).rejects.toMatchObject({ code: 'HU85_DELIVERY_PENDING', status: 503 })
  })
})
