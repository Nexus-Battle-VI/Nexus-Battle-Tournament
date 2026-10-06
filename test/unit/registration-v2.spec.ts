import { Registrations } from '../../src/application/use-cases/Registrations'
import { CALENDAR_DISTANCE_MS, validateEntryPolicy } from '../../src/domain/registration'
import { PersistedBracketEncounterSource } from '../../src/adapters/outbound/bracket/PersistedBracketEncounterSource'
import { fixture, CARD, FREE_POLICY, MIXED_POLICY } from '../support/registration-fixture'

describe('Registro y pago v2 con dobles explícitos', () => {
  it('registro emite solo comprobante de registro, sin pago ni cupo; vista filtra por actor', async () => {
    const f = fixture(),
      t = await f.create(),
      team = await f.register(t.id)
    expect(team).toMatchObject({
      status: 'AWAITING_CONSENT',
      slot: null,
      entryReceipt: null,
      ownerConsentVersion: 'team-registration-v2',
      registrationReceipt: { status: 'REGISTERED', memberIds: ['p0', 'q0'] },
    })
    expect(await f.registrations.view(t.id, 'otro')).toMatchObject({
      teams: [],
      capacity: { confirmed: 0, reserved: 0, available: 8 },
    })
  })
  it('replay normalizado conserva equipo y recibo aunque Account esté caído', async () => {
    const f = fixture(),
      t = await f.create(),
      team = await f.register(t.id)
    f.accounts.eligible.mockRejectedValue(new Error('Account caído'))
    expect(
      await f.registrations.register(t.id, 'p0', {
        operationId: 'register0',
        name: '  Equipo   0 ',
        companionId: 'q0',
        avatar: { kind: 'ACCOUNT_AVATAR', subject: 'p0' },
      }),
    ).toEqual(team)
    expect((await f.repo.read(t.id)).teams).toHaveLength(1)
  })
  it.each(['p0', 'missing', 'inactive'])(
    'rechaza compañero inválido %s sin equipo/recibo',
    async (companionId) => {
      const f = fixture(),
        t = await f.create()
      await expect(
        f.registrations.register(t.id, 'p0', {
          operationId: 'r',
          name: 'Equipo',
          avatar: { kind: 'ACCOUNT_AVATAR', subject: 'p0' },
          companionId,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_PLAYER' })
      expect((await f.repo.read(t.id)).teams).toEqual([])
    },
  )
  it('rechaza avatar ajeno y mantiene vacío el registro ante fallo de Account', async () => {
    const f = fixture(),
      t = await f.create()
    await expect(
      f.registrations.register(t.id, 'p0', {
        operationId: 'r',
        name: 'Equipo',
        companionId: 'q0',
        avatar: { kind: 'ACCOUNT_AVATAR', subject: 'otro' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TEAM_AVATAR' })
    f.accounts.validateIdentity.mockRejectedValue(new Error('Almacenamiento caído'))
    await expect(f.register(t.id)).rejects.toThrow('Almacenamiento')
    expect((await f.repo.read(t.id)).teams).toEqual([])
  })
  it('rechaza ID usado con otro nombre y miembro activo duplicado', async () => {
    const f = fixture(),
      t = await f.create()
    await f.register(t.id)
    await expect(
      f.registrations.register(t.id, 'p0', {
        operationId: 'register0',
        name: 'Otro nombre',
        companionId: 'q0',
        avatar: { kind: 'ACCOUNT_AVATAR', subject: 'p0' },
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
    await expect(
      f.registrations.register(t.id, 'nuevo', {
        operationId: 'new',
        name: 'Otro equipo',
        companionId: 'q0',
        avatar: { kind: 'ACCOUNT_AVATAR', subject: 'nuevo' },
      }),
    ).rejects.toMatchObject({ code: 'ALREADY_REGISTERED' })
  })
  it('registro concurrente con miembro común admite un equipo', async () => {
    const f = fixture(),
      t = await f.create()
    const results = await Promise.allSettled(
      ['a', 'b'].map((subject) =>
        f.registrations.register(t.id, subject, {
          operationId: subject,
          name: 'Equipo ' + subject,
          companionId: 'compartido',
          avatar: { kind: 'ACCOUNT_AVATAR', subject },
        }),
      ),
    )
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
  })
  it('pagar no sustituye al compañero; solo él acepta y se revalida elegibilidad', async () => {
    const f = fixture(),
      t = await f.create(),
      team = await f.register(t.id)
    await expect(f.registrations.consent(t.id, team.id, 'p0', 'c', true)).rejects.toMatchObject({
      status: 403,
    })
    await expect(
      f.registrations.enter(t.id, team.id, 'p0', { operationId: 'pay' }),
    ).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' })
    f.accounts.eligible.mockResolvedValue(false)
    await expect(f.registrations.consent(t.id, team.id, 'q0', 'c', true)).rejects.toMatchObject({
      code: 'INVALID_PLAYER',
    })
  })
  it('rechazo libera miembros; nuevo registro necesita consentimiento; solo miembros cancelan', async () => {
    const f = fixture(),
      t = await f.create(),
      first = await f.register(t.id)
    expect((await f.registrations.consent(t.id, first.id, 'q0', 'no', false)).status).toBe(
      'CANCELLED',
    )
    const next = await f.registrations.register(t.id, 'p0', {
      operationId: 'r2',
      name: 'Nuevo equipo',
      companionId: 'q0',
      avatar: { kind: 'ACCOUNT_AVATAR', subject: 'q0' },
    })
    expect(next.id).not.toBe(first.id)
    expect(next.consentAt).toBeNull()
    await expect(f.registrations.cancel(t.id, next.id, 'otro', 'cancel')).rejects.toMatchObject({
      status: 403,
    })
    const cancelled = await f.registrations.cancel(t.id, next.id, 'q0', 'cancel')
    expect(await f.registrations.cancel(t.id, next.id, 'q0', 'cancel')).toEqual(cancelled)
  })
  it('operationId __proto__ no altera la estructura de operaciones', async () => {
    const f = fixture(),
      t = await f.create()
    const input = {
      operationId: '__proto__',
      name: 'Equipo',
      companionId: 'q0',
      avatar: { kind: 'ACCOUNT_AVATAR' as const, subject: 'p0' },
    }
    const a = await f.registrations.register(t.id, 'p0', input),
      b = await f.registrations.register(t.id, 'p0', input)
    expect(a.id).toBe(b.id)
  })
  it('gratis no llama a Wallet ni a pasarela, y no permite cancelar la confirmación', async () => {
    const f = fixture(undefined, FREE_POLICY),
      t = await f.create(),
      team = await f.confirm(t.id)
    expect(team.entryReceipt?.payment).toEqual({
      method: 'FREE',
      amount: 0,
      chargeId: null,
      payerId: 'p0',
      realMoneyMoved: false,
    })
    expect(team.registrationReceipt.id).not.toBe(team.entryReceipt?.id)
    expect(f.wallet.debits).toBe(0)
    await expect(f.registrations.cancel(t.id, team.id, 'q0', 'c')).rejects.toMatchObject({
      code: 'INVALID_TEAM_STATE',
    })
  })
  it('creador paga tarifa del servidor; replay no repite descuento', async () => {
    const f = fixture(),
      t = await f.create(),
      team = await f.accept(t.id)
    await expect(
      f.registrations.enter(t.id, team.id, 'q0', { operationId: 'pay' }),
    ).rejects.toMatchObject({ status: 403 })
    const paid = await f.registrations.enter(t.id, team.id, 'p0', { operationId: 'pay' })
    expect(paid.entryReceipt?.payment).toMatchObject({
      method: 'CREDITS',
      amount: 100,
      realMoneyMoved: false,
    })
    expect(await f.registrations.enter(t.id, team.id, 'p0', { operationId: 'pay' })).toEqual(paid)
    expect(f.wallet.balances.get('p0')).toBe(20)
    expect(f.wallet.debits).toBe(1)
  })
  it('saldo insuficiente es rechazo durable; corregir saldo exige otro ID', async () => {
    const f = fixture(),
      t = await f.create(),
      team = await f.accept(t.id)
    f.wallet.balances.set('p0', 99)
    await expect(
      f.registrations.enter(t.id, team.id, 'p0', { operationId: 'pay' }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' })
    f.wallet.balances.set('p0', 120)
    await expect(
      f.registrations.enter(t.id, team.id, 'p0', { operationId: 'pay' }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' })
    expect(f.wallet.debits).toBe(0)
    expect((await f.registrations.enter(t.id, team.id, 'p0', { operationId: 'new' })).status).toBe(
      'CONFIRMED',
    )
  })
  it('timeout después del débito guarda reserva; reinicio recupera sin descontar otra vez', async () => {
    const f = fixture(),
      t = await f.create(),
      team = await f.accept(t.id)
    f.wallet.uncertainCharge = true
    expect((await f.registrations.enter(t.id, team.id, 'p0', { operationId: 'pay' })).status).toBe(
      'PAYMENT_PENDING',
    )
    const restarted = new Registrations(f.repo, f.accounts, f.wallet, f.clock, f.simulator)
    await restarted.reconcile()
    await restarted.reconcile()
    expect((await f.repo.read(t.id)).teams[0]?.status).toBe('CONFIRMED')
    expect(f.wallet.debits).toBe(1)
  })
  it('cierre después de cobro compensa y recupera timeout de devolución sin liberar anticipadamente', async () => {
    const f = fixture(),
      t = await f.create(),
      team = await f.accept(t.id)
    f.wallet.afterCharge = () => {
      f.setNow('2026-10-10T00:00:00Z')
    }
    f.wallet.uncertainRefund = true
    expect(await f.registrations.enter(t.id, team.id, 'p0', { operationId: 'pay' })).toMatchObject({
      status: 'COMPENSATING',
      slot: 1,
      entryReceipt: null,
    })
    await f.registrations.reconcile()
    expect((await f.repo.read(t.id)).teams[0]).toMatchObject({
      status: 'PENDING_PAYMENT',
      slot: null,
      entryReceipt: null,
    })
    expect(f.wallet.refunds).toBe(1)
    expect(f.wallet.balances.get('p0')).toBe(120)
    await expect(
      f.registrations.enter(t.id, team.id, 'p0', { operationId: 'pay' }),
    ).rejects.toMatchObject({ code: 'PAYMENT_COMPENSATED' })
  })
  it('cierre exacto antes del pago impide débito', async () => {
    const f = fixture(),
      t = await f.create(),
      team = await f.accept(t.id)
    f.setNow('2026-10-10T00:00:00Z')
    await expect(
      f.registrations.enter(t.id, team.id, 'p0', { operationId: 'pay' }),
    ).rejects.toMatchObject({ code: 'REGISTRATION_CLOSED' })
    expect(f.wallet.debits).toBe(0)
  })
  it('simulado aprobado guarda solo datos saneados y replay no necesita tarjeta', async () => {
    const f = fixture(undefined, MIXED_POLICY),
      t = await f.create(),
      team = await f.accept(t.id)
    const paid = await f.registrations.enter(t.id, team.id, 'p0', {
      operationId: 'pay',
      method: 'SIMULATED_MONEY',
      card: CARD,
    })
    expect(paid.entryReceipt?.payment).toMatchObject({
      method: 'SIMULATED_MONEY',
      amountMinor: 250050,
      currency: 'COP',
      minorUnit: 2,
      maskedCard: '1111',
      simulated: true,
      realMoneyMoved: false,
    })
    expect(await f.registrations.enter(t.id, team.id, 'p0', { operationId: 'pay' })).toEqual(paid)
    const persisted = JSON.stringify(await f.repo.read(t.id))
    for (const secret of [CARD.holder, CARD.number, CARD.expiry, CARD.securityCode])
      expect(persisted).not.toContain(JSON.stringify(secret))
    expect(f.wallet.debits).toBe(0)
  })
  it('rechazo simulado no ocupa plaza y conserva rechazo con otra tarjeta; otro ID puede aprobar', async () => {
    const f = fixture(undefined, MIXED_POLICY),
      t = await f.create(),
      team = await f.accept(t.id)
    await expect(
      f.registrations.enter(t.id, team.id, 'p0', {
        operationId: 'pay',
        method: 'SIMULATED_MONEY',
        card: { ...CARD, number: '4111111111110000' },
      }),
    ).rejects.toMatchObject({ code: 'SIMULATED_PAYMENT_DECLINED' })
    await expect(
      f.registrations.enter(t.id, team.id, 'p0', { operationId: 'pay', card: CARD }),
    ).rejects.toMatchObject({ code: 'SIMULATED_PAYMENT_DECLINED' })
    expect((await f.repo.read(t.id)).teams[0]).toMatchObject({
      slot: null,
      entryReceipt: null,
      status: 'PENDING_PAYMENT',
    })
    expect(
      (
        await f.registrations.enter(t.id, team.id, 'p0', {
          operationId: 'next',
          method: 'SIMULATED_MONEY',
          card: CARD,
        })
      ).status,
    ).toBe('CONFIRMED')
  })
  it('última plaza admite uno de dos intentos mixtos concurrentes', async () => {
    const f = fixture(undefined, MIXED_POLICY),
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
    const results = await Promise.allSettled([
      f.registrations.enter(t.id, a.id, 'p7', { operationId: 'a', method: 'CREDITS' }),
      f.registrations.enter(t.id, b.id, 'p8', {
        operationId: 'b',
        method: 'SIMULATED_MONEY',
        card: CARD,
      }),
    ])
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    expect((await f.repo.read(t.id)).teams.filter((x) => x.status === 'CONFIRMED')).toHaveLength(8)
  })
  it('dos métodos exigen selección; dinero simulado exige datos solo para operación nueva', async () => {
    const f = fixture(undefined, MIXED_POLICY),
      t = await f.create(),
      team = await f.accept(t.id)
    await expect(
      f.registrations.enter(t.id, team.id, 'p0', { operationId: 'pay' }),
    ).rejects.toMatchObject({ code: 'PAYMENT_METHOD_NOT_CONFIGURED' })
    await expect(
      f.registrations.enter(t.id, team.id, 'p0', { operationId: 'pay', method: 'SIMULATED_MONEY' }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
  })
})
describe('Llaves y calendario v2', () => {
  it.each([5, 7])('con %i confirmados no publica ni cierra', async (count) => {
    const f = fixture(undefined, FREE_POLICY),
      t = await f.create()
    for (let n = 0; n < count; n++) await f.confirm(t.id, n)
    await expect(f.brackets.publish(t.id, 'admin', 'pub')).rejects.toMatchObject({
      code: 'INSUFFICIENT_CONFIRMED_TEAMS',
    })
    expect((await f.registrations.view(t.id, 'p0')).tournament.open).toBe(true)
    expect(await f.encounters.findAllByTournament(t.id)).toEqual([])
  })
  it('ocho equipos producen snapshot único, grafo cruzado, 14 identidades y preparación pendiente', async () => {
    const f = fixture(undefined, FREE_POLICY),
      t = await f.create()
    for (let n = 0; n < 8; n++) await f.confirm(t.id, n)
    const [a, b] = await Promise.all([
      f.brackets.publish(t.id, 'admin', 'a'),
      f.brackets.publish(t.id, 'admin2', 'b'),
    ])
    expect(a).toEqual(b)
    expect(a.version).toBe(2)
    expect(a.matches).toHaveLength(14)
    expect(new Set(a.seeds.flatMap((x) => x.memberIds)).size).toBe(16)
    expect(a.matches.find((x) => x.id === 'E9')?.sources[0]).toEqual({
      kind: 'LOSER',
      matchId: 'E6',
    })
    expect(a.matches.find((x) => x.id === 'E10')?.sources[0]).toEqual({
      kind: 'LOSER',
      matchId: 'E5',
    })
    expect(a.matches.find((x) => x.id === 'Final')?.round).toBe(6)
    const source = new PersistedBracketEncounterSource(f.repo),
      encounters = await source.listEncounters(t.id)
    expect(encounters).toHaveLength(14)
    expect(encounters[0]).toMatchObject({
      encounterId: t.id + ':E1',
      status: 'WAITING_PARTICIPANTS',
      teams: [],
      combatRoomId: null,
      result: null,
      bracketMetadata: { preparationStatus: 'TEAMS_RESOLVED' },
    })
    expect(
      encounters.filter((x) => x.bracketMetadata?.preparationStatus === 'TEAMS_RESOLVED'),
    ).toHaveLength(4)
    expect((await f.registrations.view(t.id, 'p0')).tournament.open).toBe(false)
    expect(await source.listEncounters('unknown')).toEqual([])
  })
  it('ID del registro no sirve para publicar', async () => {
    const f = fixture(),
      t = await f.create()
    await f.register(t.id)
    await expect(f.brackets.publish(t.id, 'admin', 'register0')).rejects.toMatchObject({
      code: 'OPERATION_CONFLICT',
    })
  })
  it.each([-1, 1])(
    'calendario compara hacia ambos sentidos %i y mantiene replay administrativo',
    async (sign) => {
      const f = fixture(),
        t = await f.create(),
        start = new Date(t.startsAt).getTime()
      const command = (distance: number) => {
        const date = start + sign * distance
        return {
          operationId: 'new',
          name: 'Segundo',
          entryFee: 0,
          opensAt: new Date(date - 2 * 86400000).toISOString(),
          closesAt: new Date(date - 86400000).toISOString(),
          startsAt: new Date(date).toISOString(),
        }
      }
      for (const distance of [90 * 86400000, CALENDAR_DISTANCE_MS - 1])
        await expect(f.registrations.create('admin', command(distance))).rejects.toMatchObject({
          code: 'CALENDAR_CONFLICT',
        })
      const created = await f.registrations.create('admin', command(CALENDAR_DISTANCE_MS))
      expect(created.id).not.toBe('new')
      expect(await f.registrations.create('admin', command(CALENDAR_DISTANCE_MS))).toEqual(created)
    },
  )
  it.each([
    { version: 1, free: true, methods: [{ method: 'CREDITS', amount: 1 }] },
    { version: 1, free: false, methods: [] },
    { version: 1, free: false, methods: [{ method: 'CREDITS', amount: 1.5 }] },
    {
      version: 1,
      free: false,
      methods: [
        { method: 'CREDITS', amount: 1 },
        { method: 'CREDITS', amount: 2 },
      ],
    },
    {
      version: 1,
      free: false,
      methods: [{ method: 'SIMULATED_MONEY', amountMinor: 100, currency: 'cop', minorUnit: 2 }],
    },
    {
      version: 1,
      free: false,
      methods: [{ method: 'SIMULATED_MONEY', amountMinor: 100, currency: 'COP', minorUnit: 7 }],
    },
  ])('configuración ambigua o inválida %#', (policy) => {
    expect(() => validateEntryPolicy(policy)).toThrow()
  })
})
