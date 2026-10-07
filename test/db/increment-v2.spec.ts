import type { Kysely } from 'kysely'
import { generateBracket } from '../../src/domain/bracket'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import {
  createDatabase,
  migrateToLatest,
  MIGRATIONS,
} from '../../src/infrastructure/persistence/database'
import { PostgresRegistrationRepository } from '../../src/adapters/outbound/persistence/PostgresRegistrationRepository'
import { PostgresTournamentEncounterRepository } from '../../src/adapters/outbound/persistence/PostgresTournamentEncounterRepository'
import { migration001TournamentEncounters } from '../../src/adapters/outbound/persistence/migrations/001-tournament-encounters'
import { Registrations } from '../../src/application/use-cases/Registrations'
import { ListTournamentMatches } from '../../src/application/use-cases/ListTournamentMatches'
import { GetTournamentMatchDetail } from '../../src/application/use-cases/GetTournamentMatchDetail'
import { PersistedBracketEncounterSource } from '../../src/adapters/outbound/bracket/PersistedBracketEncounterSource'
import { HttpCombatRecordAdapter } from '../../src/adapters/outbound/combat/HttpCombatRecordAdapter'
import {
  toMatchSummaryResponse,
  toMatchDetailResponse,
} from '../../src/adapters/inbound/http/dto/tournament-match.dto'
import { fixture, FREE_POLICY, MIXED_POLICY, CARD } from '../support/registration-fixture'
import { startTestPostgres } from '../support/postgres'

describe('Combinación HU-77/84/78/83 en PostgreSQL real aislado', () => {
  it('sin pertenencias activas completas el trigger rechaza snapshot y no crea filas', async () => {
    await migrate()
    const f = fixture(new PostgresRegistrationRepository(db), FREE_POLICY),
      t = await f.create()
    for (let n = 0; n < 8; n++) await f.confirm(t.id, n)
    await expect(
      db
        .deleteFrom('registration_members')
        .where('tournament_id', '=', t.id)
        .where('player_id', '=', 'q7')
        .execute(),
    ).rejects.toThrow('INVALID_TEAM_MEMBERS')
    // Publicación reconstruye pertenencias dentro de la misma transacción; la comprobación SQL directa sigue siendo obligatoria.
    const snapshot = generateBracket(await f.repo.read(t.id), 'direct', 'admin', f.clock.now())
    await expect(
      db.transaction().execute(async (tx) => {
        await tx
          .deleteFrom('registration_members')
          .where('tournament_id', '=', t.id)
          .where('player_id', '=', 'q7')
          .execute()
        await tx
          .updateTable('tournaments')
          .set({ bracket: JSON.stringify(snapshot) })
          .where('id', '=', t.id)
          .execute()
      }),
    ).rejects.toThrow('INVALID_BRACKET_ROSTER')
    expect(
      await new PostgresTournamentEncounterRepository(db).findAllByTournament(t.id),
    ).toHaveLength(0)
  })
  it('rechaza snapshot incompleto, inserción de bracket y cierre tardío del archivo', async () => {
    await migrate()
    const f = fixture(new PostgresRegistrationRepository(db), FREE_POLICY),
      t = await f.create()
    await expect(
      db.updateTable('tournaments').set({ bracket: '{}' }).where('id', '=', t.id).execute(),
    ).rejects.toThrow('INVALID_BRACKET_ROSTER')
    await expect(
      db
        .insertInto('tournaments')
        .values({
          id: 'invalid-direct-insert',
          name: 'Prueba',
          entry_policy: JSON.stringify(FREE_POLICY),
          entry_fee: 0,
          bracket: '{}',
          opens_at: new Date('2027-03-01T00:00:00Z'),
          closes_at: new Date('2027-03-10T00:00:00Z'),
          starts_at: new Date('2027-03-12T00:00:00Z'),
          starts_epoch: new Date('2027-03-12T00:00:00Z').getTime(),
        })
        .execute(),
    ).rejects.toThrow('BRACKET_REQUIRES_PUBLICATION')
    const archive = new PostgresTournamentEncounterRepository(db),
      finished = legacy()
    await archive.save(finished)
    await Promise.all([
      archive.save({
        ...finished,
        status: 'READY',
        result: null,
        closedAt: null,
        lastSyncedSeq: 0,
        logComplete: false,
      }),
      archive.save({ ...finished, result: { ...finished.result, winnerTeamLabel: 'B' } }),
    ])
    expect(await archive.findOne(finished.tournamentId, finished.encounterId)).toMatchObject({
      status: 'FINISHED',
      lastSyncedSeq: 120,
      result: { winnerTeamLabel: 'A' },
      logComplete: true,
    })
    expect(await archive.findLinked()).toHaveLength(0)
    await archive.save({
      ...legacy('pending', 'E2'),
      status: 'IN_PROGRESS',
      closedAt: null,
      result: null,
      logComplete: false,
    })
    expect(await archive.findLinked()).toHaveLength(1)
  })
  it.each([-1, 1])('fronteras UTC en PostgreSQL en sentido %i', async (sign) => {
    await migrate()
    const f = fixture(new PostgresRegistrationRepository(db)),
      t = await f.create()
    const command = (distance: number) => {
      const date = new Date(t.startsAt).getTime() + sign * distance
      return {
        operationId: 'second',
        name: 'Segundo',
        entryFee: 0,
        opensAt: new Date(date - 2 * 86400000).toISOString(),
        closesAt: new Date(date - 86400000).toISOString(),
        startsAt: new Date(date).toISOString(),
      }
    }
    for (const days of [90 * 86400000, 91 * 86400000 - 1])
      await expect(f.registrations.create('admin', command(days))).rejects.toMatchObject({
        code: 'CALENDAR_CONFLICT',
      })
    expect((await f.registrations.create('admin', command(91 * 86400000))).entryPolicy).toEqual(
      FREE_POLICY,
    )
  })
  let runtime: Awaited<ReturnType<typeof startTestPostgres>>
  let db: Kysely<Database>
  beforeEach(async () => {
    runtime = await startTestPostgres()
    db = createDatabase({ connectionString: runtime.connectionString })
  }, 120000)
  afterEach(async () => {
    await db.destroy()
    await runtime.stop()
  })
  const migrate = async () => {
    const result = await migrateToLatest(db)
    if (result.error !== undefined)
      throw result.error instanceof Error ? result.error : new Error('Falló la migración.')
  }
  const legacy = (tournamentId = 'historico', encounterId = 'E1') => ({
    tournamentId,
    encounterId,
    round: 1,
    bracketLabel: 'E1',
    teams: [
      {
        teamId: 'antiguo-a',
        teamLabel: 'A',
        participants: [{ playerId: 'old-a', heroId: 'old-hero-a' }],
      },
      {
        teamId: 'antiguo-b',
        teamLabel: 'B',
        participants: [{ playerId: 'old-b', heroId: 'old-hero-b' }],
      },
    ],
    status: 'FINISHED' as const,
    combatRoomId: 'old-room',
    startedAt: new Date('2026-09-01T00:00:00Z'),
    closedAt: new Date('2026-09-01T00:10:00Z'),
    result: {
      winnerTeamLabel: 'A',
      reason: 'ELIMINATION',
      outcome: 'WIN',
      finishedAt: new Date('2026-09-01T00:10:00Z'),
    },
    lastSyncedSeq: 120,
    logComplete: true,
  })
  it('actualiza desde 001 con roster/resultado/120 eventos y mantiene paginación HU-83', async () => {
    const baseline = await migrateToLatest(db, {
      '001-tournament-encounters': migration001TournamentEncounters,
    })
    expect(baseline.error).toBeUndefined()
    const archive = new PostgresTournamentEncounterRepository(db),
      original = legacy()
    await archive.save(original)
    await archive.appendEvents(
      Array.from({ length: 120 }, (_, i) => ({
        tournamentId: original.tournamentId,
        encounterId: original.encounterId,
        seq: i + 1,
        type: 'evento-historico',
        occurredAt: original.startedAt,
        payload: { persistedBeforeUpgrade: i + 1 },
      })),
    )
    const upgrade = await migrateToLatest(db)
    expect(upgrade.error).toBeUndefined()
    expect(upgrade.applied).toEqual([
      '002-tournament-registration',
      '003-tournament-bracket',
      '004-tournament-admin-actions',
      '006-tournament-mode-members-progression',
      '007-tournament-round-acceptance-resolution',
      '008-tournament-external-links',
      '009-tournament-broadcast',
    ])
    expect(await archive.findOne(original.tournamentId, original.encounterId)).toEqual(original)
    const f = fixture(new PostgresRegistrationRepository(db))
    const source = new PersistedBracketEncounterSource(f.repo),
      combat = new HttpCombatRecordAdapter(undefined, null)
    const query = new GetTournamentMatchDetail(archive, source, combat)
    const page = await query.execute('historico', 'E1', 0)
    const dto = toMatchDetailResponse(page.encounter, page.events, 0)
    expect(dto.events).toHaveLength(100)
    expect(dto).toMatchObject({
      matchId: 'E1',
      status: 'FINISHED',
      nextSeq: 100,
      hasMore: true,
      logComplete: true,
    })
    expect((await query.execute('historico', 'E1', 100)).events.events).toHaveLength(20)
    await expect(query.execute('otro', 'E1', 0)).rejects.toThrow()
    expect((await migrateToLatest(db)).applied).toEqual([])
    expect(Object.keys(MIGRATIONS)).toEqual([
      '001-tournament-encounters',
      '002-tournament-registration',
      '003-tournament-bracket',
      '004-tournament-admin-actions',
      '006-tournament-mode-members-progression',
      '007-tournament-round-acceptance-resolution',
      '008-tournament-external-links',
      '009-tournament-broadcast',
    ])
  })
  it('conserva registro/consentimientos/recibos al reconstruir adaptadores', async () => {
    await migrate()
    const f = fixture(new PostgresRegistrationRepository(db)),
      t = await f.create(),
      team = await f.confirm(t.id)
    const recovered = await new PostgresRegistrationRepository(db).read(t.id)
    expect(recovered.teams[0]).toEqual(team)
    expect(recovered.teams[0]?.ownerConsentVersion).toBe('team-registration-v2')
    expect(f.wallet.debits).toBe(1)
    expect(await f.create()).toEqual(t)
    await expect(
      f.registrations.create('otro-admin', {
        operationId: 'create',
        name: t.name,
        entryPolicy: t.entryPolicy,
        opensAt: t.opensAt,
        closesAt: t.closesAt,
        startsAt: t.startsAt,
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
  })
  it('pertenencias y slot tienen restricciones SQL además de validación de aplicación', async () => {
    await migrate()
    const f = fixture(new PostgresRegistrationRepository(db)),
      t = await f.create(),
      team = await f.confirm(t.id)
    await expect(
      db
        .insertInto('registration_members')
        .values({ tournament_id: t.id, team_id: team.id, player_id: 'p0' })
        .execute(),
    ).rejects.toMatchObject({ code: '23505' })
    await expect(
      db.updateTable('registration_teams').set({ slot: 9 }).where('id', '=', team.id).execute(),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(new PostgresRegistrationRepository(db).read('no-existe')).rejects.toMatchObject({
      code: 'TOURNAMENT_NOT_FOUND',
    })
  })
  it('último cupo mixto concurrente entre dos instancias solo confirma uno', async () => {
    await migrate()
    const f = fixture(new PostgresRegistrationRepository(db), MIXED_POLICY),
      t = await f.create()
    for (let n = 0; n < 7; n++) {
      const team = await f.accept(t.id, n)
      await f.registrations.enter(t.id, team.id, 'p' + String(n), {
        operationId: 'pay' + String(n),
        method: 'CREDITS',
      })
    }
    const a = await f.accept(t.id, 7),
      b = await f.accept(t.id, 8)
    const other = new Registrations(
      new PostgresRegistrationRepository(db),
      f.accounts,
      f.wallet,
      f.clock,
      f.simulator,
    )
    const results = await Promise.allSettled([
      f.registrations.enter(t.id, a.id, 'p7', { operationId: 'last-a', method: 'CREDITS' }),
      other.enter(t.id, b.id, 'p8', {
        operationId: 'last-b',
        method: 'SIMULATED_MONEY',
        card: CARD,
      }),
    ])
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    const persisted = await f.repo.read(t.id)
    expect(persisted.teams.filter((x) => x.status === 'CONFIRMED')).toHaveLength(8)
    expect(new Set(persisted.teams.filter((x) => x.slot !== null).map((x) => x.slot)).size).toBe(8)
    expect(
      persisted.teams.filter((x) => x.status !== 'CONFIRMED').every((x) => x.entryReceipt === null),
    ).toBe(true)
  })
  it('compensación tras reinicio y timeout de devolución no duplica débito/reembolso', async () => {
    await migrate()
    const f = fixture(new PostgresRegistrationRepository(db)),
      t = await f.create(),
      team = await f.accept(t.id)
    f.wallet.uncertainCharge = true
    expect((await f.registrations.enter(t.id, team.id, 'p0', { operationId: 'pay' })).status).toBe(
      'PAYMENT_PENDING',
    )
    f.setNow('2026-10-10T00:00:00Z')
    f.wallet.uncertainRefund = true
    const restarted = new Registrations(
      new PostgresRegistrationRepository(db),
      f.accounts,
      f.wallet,
      f.clock,
      f.simulator,
    )
    await restarted.reconcile()
    expect((await f.repo.read(t.id)).teams[0]?.status).toBe('COMPENSATING')
    await restarted.reconcile()
    expect((await f.repo.read(t.id)).teams[0]).toMatchObject({
      status: 'PENDING_PAYMENT',
      slot: null,
      entryReceipt: null,
    })
    expect(f.wallet.debits).toBe(1)
    expect(f.wallet.refunds).toBe(1)
  })
  it.each([true, false])(
    'simulado aprobado=%s es durable y no persiste datos de tarjeta',
    async (approved) => {
      await migrate()
      const f = fixture(new PostgresRegistrationRepository(db), MIXED_POLICY),
        t = await f.create(),
        team = await f.accept(t.id)
      const card = { ...CARD, number: approved ? CARD.number : '4111111111110000' }
      const attempt = f.registrations.enter(t.id, team.id, 'p0', {
        operationId: 'pay',
        method: 'SIMULATED_MONEY',
        card,
      })
      if (approved) expect((await attempt).status).toBe('CONFIRMED')
      else await expect(attempt).rejects.toMatchObject({ code: 'SIMULATED_PAYMENT_DECLINED' })
      const restart = new Registrations(
        new PostgresRegistrationRepository(db),
        f.accounts,
        f.wallet,
        f.clock,
        f.simulator,
      )
      const replay = restart.enter(t.id, team.id, 'p0', { operationId: 'pay' })
      if (approved)
        expect((await replay).entryReceipt?.payment).toMatchObject({
          simulated: true,
          realMoneyMoved: false,
        })
      else await expect(replay).rejects.toMatchObject({ code: 'SIMULATED_PAYMENT_DECLINED' })
      const stored = JSON.stringify(await f.repo.read(t.id))
      for (const secret of [card.holder, card.number, card.expiry, card.securityCode])
        expect(stored).not.toContain(JSON.stringify(secret))
      expect(stored).not.toContain('"securityCode"')
      expect(f.wallet.debits).toBe(0)
    },
  )
  it('ocho inscripciones publican atómicamente 14 filas HU-83, sin héroes, y snapshot es inmutable', async () => {
    await migrate()
    const f = fixture(new PostgresRegistrationRepository(db), FREE_POLICY),
      t = await f.create()
    for (let n = 0; n < 8; n++) await f.confirm(t.id, n)
    const [a, b] = await Promise.all([
      f.brackets.publish(t.id, 'admin', 'a'),
      f.brackets.publish(t.id, 'admin2', 'b'),
    ])
    expect(a).toEqual(b)
    const archive = new PostgresTournamentEncounterRepository(db)
    const source = new PersistedBracketEncounterSource(new PostgresRegistrationRepository(db))
    const list = await new ListTournamentMatches(
      archive,
      source,
      new HttpCombatRecordAdapter(undefined, null),
    ).execute(t.id)
    const summaries = list.map(toMatchSummaryResponse)
    expect(summaries).toHaveLength(14)
    expect(summaries.filter((x) => x.preparationStatus === 'TEAMS_RESOLVED')).toHaveLength(4)
    expect(
      summaries.every(
        (x) =>
          x.status === 'WAITING_PARTICIPANTS' &&
          x.combatRoomId === null &&
          x.matchId === x.encounterId,
      ),
    ).toBe(true)
    expect(
      (await archive.findAllByTournament(t.id)).every(
        (x) => x.teams.length === 0 && x.result === null,
      ),
    ).toBe(true)
    await expect(
      db
        .updateTable('tournaments')
        .set({ bracket: JSON.stringify({ ...a, publishedBy: 'otro' }) })
        .where('id', '=', t.id)
        .execute(),
    ).rejects.toThrow('IMMUTABLE_BRACKET')
    expect((await new PostgresRegistrationRepository(db).read(t.id)).bracket).toEqual(a)
    await expect(
      f.repo.change(t.id, (current) => {
        current.bracket!.publishedBy = 'otro'
      }),
    ).rejects.toMatchObject({ code: 'IMMUTABLE_BRACKET' })
    expect((await f.repo.read(t.id)).bracket).toEqual(a)
  })
  it('colisión con justa archivada revierte publicación/cierre y conserva el archivo', async () => {
    await migrate()
    const f = fixture(new PostgresRegistrationRepository(db), FREE_POLICY),
      t = await f.create()
    for (let n = 0; n < 8; n++) await f.confirm(t.id, n)
    const archive = new PostgresTournamentEncounterRepository(db),
      old = legacy(t.id, t.id + ':E1')
    await archive.save(old)
    await expect(f.brackets.publish(t.id, 'admin', 'pub')).rejects.toMatchObject({
      code: 'ENCOUNTER_IDENTITY_CONFLICT',
    })
    expect((await f.repo.read(t.id)).bracket).toBeNull()
    expect((await f.registrations.view(t.id, 'p0')).tournament.open).toBe(true)
    expect(await archive.findOne(t.id, t.id + ':E1')).toEqual(old)
    expect(await archive.findAllByTournament(t.id)).toHaveLength(1)
  })
  it('calendario SQL rechaza solapamiento aunque se salte el caso de uso; 91 días exactos pasan', async () => {
    await migrate()
    const f = fixture(new PostgresRegistrationRepository(db)),
      t = await f.create()
    const row = (distance: number) => {
      const date = new Date(t.startsAt).getTime() + distance
      return {
        id: 'sql-' + String(distance),
        name: 'SQL prueba',
        entry_policy: JSON.stringify(FREE_POLICY),
        entry_fee: 0,
        opens_at: new Date(date - 2 * 86400000),
        closes_at: new Date(date - 86400000),
        starts_at: new Date(date),
        starts_epoch: date,
      }
    }
    await expect(
      db
        .insertInto('tournaments')
        .values(row(91 * 86400000 - 1))
        .execute(),
    ).rejects.toMatchObject({ code: '23P01' })
    await expect(
      db
        .insertInto('tournaments')
        .values(row(91 * 86400000))
        .execute(),
    ).resolves.toBeDefined()
  })
  it('crear dos torneos concurrentes próximos confirma solo uno', async () => {
    await migrate()
    const f = fixture(new PostgresRegistrationRepository(db))
    const base = {
      name: 'Concurrente',
      entryFee: 0,
      opensAt: '2026-10-01T00:00:00Z',
      closesAt: '2026-10-10T00:00:00Z',
    }
    const outcomes = await Promise.allSettled([
      f.registrations.create('admin', {
        ...base,
        operationId: 'a',
        startsAt: '2026-10-12T00:00:00Z',
      }),
      f.registrations.create('admin', {
        ...base,
        operationId: 'b',
        startsAt: '2026-10-13T00:00:00Z',
      }),
    ])
    expect(outcomes.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    expect(await f.repo.list()).toHaveLength(1)
  })
})
