import { fixture, FREE_POLICY, MIXED_POLICY, CARD } from '../support/registration-fixture'
import { acceptanceFixture } from '../support/acceptance-fixture'
import { InMemoryLifecycleRepository } from '../../src/adapters/outbound/persistence/InMemoryLifecycleRepository'
import { TournamentClosures } from '../../src/application/use-cases/TournamentClosures'
import { AcceptanceReconciliation } from '../../src/application/use-cases/AcceptanceReconciliation'

describe('Cierre sin campeón y devolución de inscripción', () => {
  it('respeta el inicio futuro y cierra exactamente a los treinta minutos de inactividad', async () => {
    const f = fixture(undefined, FREE_POLICY),
      t = await f.create()
    const lifecycle = new InMemoryLifecycleRepository()
    const close = new TournamentClosures(f.repo, lifecycle, f.wallet, f.clock)
    await close.sweep()
    expect((await f.repo.read(t.id)).closure).toBeUndefined()
    f.setNow('2026-10-12T00:29:59.999Z')
    await close.sweep()
    expect((await f.repo.read(t.id)).closure).toBeUndefined()
    f.setNow('2026-10-12T00:30:00Z')
    await close.sweep()
    expect((await f.registrations.view(t.id, 'p0')).tournament).toMatchObject({
      open: false,
      closure: { reason: 'INACTIVITY', refundStatus: 'COMPLETE' },
    })
    expect((await lifecycle.read(t.id)).champion).toBeNull()
    expect(f.wallet.refunds).toBe(0)
  })

  it('una aceptación real reinicia el plazo; consultas y barridos no cuentan como actividad', async () => {
    const f = await acceptanceFixture({ mode: 'SOLO' })
    const close = new TournamentClosures(f.repo, f.lifecycle, f.wallet, f.clock)
    f.setOpen()
    await f.acceptSide()
    const at = (await f.repo.read(f.id)).lastActivityAt!
    f.setNow(new Date(new Date(at).getTime() + 29 * 60_000).toISOString())
    await f.acceptance.view(f.id, f.e().encounterId, f.b.seeds[0]!.memberIds[0])
    await close.sweep()
    expect((await f.repo.read(f.id)).closure).toBeUndefined()
    f.setNow(new Date(new Date(at).getTime() + 30 * 60_000).toISOString())
    await close.sweep()
    await expect(f.acceptance.accept(f.id, f.e().encounterId, 'p0', 'late')).rejects.toMatchObject({
      code: 'TOURNAMENT_CLOSED',
    })
    const worker = new AcceptanceReconciliation(
      f.repo,
      f.acceptance,
      f.administration,
      f.progress,
      close,
    )
    await worker.sweep()
    expect(f.commands.createRoom).not.toHaveBeenCalled()
    expect(await f.acceptance.view(f.id, f.e().encounterId)).toMatchObject({
      operationalStatus: 'TOURNAMENT_CLOSED',
    })
  })

  it('devuelve créditos una vez al pagador y conserva equipos, recibos y llaves', async () => {
    const f = fixture(),
      t = await f.create()
    for (let n = 0; n < 8; n++) await f.confirm(t.id, n)
    f.setNow('2026-10-10T00:00:00Z')
    await f.brackets.publish(t.id, 'admin', 'publish')
    const before = await f.repo.read(t.id)
    const lifecycle = new InMemoryLifecycleRepository()
    const close = new TournamentClosures(f.repo, lifecycle, f.wallet, f.clock)
    await Promise.all([close.close(t.id, 'admin', 'close'), close.close(t.id, 'admin', 'close')])
    await new TournamentClosures(f.repo, lifecycle, f.wallet, f.clock).sweep()
    const after = await f.repo.read(t.id)
    expect(after.teams).toEqual(before.teams)
    expect(after.bracket).toEqual(before.bracket)
    expect(f.wallet.refunds).toBe(8)
    expect(f.wallet.balances.get('p0')).toBe(120)
    const own = await f.registrations.view(t.id, 'p0')
    expect(own.refunds).toHaveLength(1)
    expect(own.refunds[0]).toMatchObject({ payerId: 'p0', amount: 100, status: 'REFUNDED' })
    expect((await f.registrations.view(t.id, 'q0')).refunds).toEqual([])
    expect(JSON.stringify(own.tournament.closure)).not.toContain('payerId')
    await expect(f.brackets.publish(t.id, 'admin', 'republish')).rejects.toMatchObject({
      code: 'TOURNAMENT_CLOSED',
    })
  })

  it('recupera un cobro de respuesta perdida y un reembolso de respuesta perdida después de reiniciar', async () => {
    const f = fixture(),
      t = await f.create(),
      team = await f.accept(t.id)
    f.wallet.uncertainCharge = true
    await f.registrations.enter(t.id, team.id, 'p0', { operationId: 'pay' })
    f.wallet.uncertainRefund = true
    const lifecycle = new InMemoryLifecycleRepository()
    const close = new TournamentClosures(f.repo, lifecycle, f.wallet, f.clock)
    await close.close(t.id, 'admin', 'close')
    expect((await f.repo.read(t.id)).closure?.refunds[0]?.status).toBe('PENDING')
    await new TournamentClosures(f.repo, lifecycle, f.wallet, f.clock).sweep()
    expect((await f.repo.read(t.id)).closure?.refunds[0]).toMatchObject({
      status: 'REFUNDED',
      lastError: null,
    })
    expect(f.wallet.debits).toBe(1)
    expect(f.wallet.refunds).toBe(1)
    expect(f.wallet.balances.get('p0')).toBe(120)
  })

  it('rechaza un recibo de devolución de otro pagador sin marcar el reembolso completo', async () => {
    const f = fixture(),
      t = await f.create()
    await f.confirm(t.id)
    const wallet = {
      charge: f.wallet.charge.bind(f.wallet),
      refund: async (id: string, op: string) => ({
        ...(await f.wallet.refund(id, op)),
        payerId: 'intruso',
      }),
    }
    const close = new TournamentClosures(f.repo, new InMemoryLifecycleRepository(), wallet, f.clock)
    await close.close(t.id, 'admin', 'close')
    expect((await f.repo.read(t.id)).closure?.refunds[0]).toMatchObject({
      status: 'PENDING',
      lastError: 'WALLET_PROTOCOL_ERROR',
    })
  })

  it('anula la inscripción de dinero simulado sin llamar a Wallet ni mover dinero', async () => {
    const f = fixture(undefined, MIXED_POLICY),
      t = await f.create(),
      team = await f.accept(t.id)
    await f.registrations.enter(t.id, team.id, 'p0', {
      operationId: 'money',
      method: 'SIMULATED_MONEY',
      card: CARD,
    })
    const close = new TournamentClosures(
      f.repo,
      new InMemoryLifecycleRepository(),
      f.wallet,
      f.clock,
    )
    await close.close(t.id, 'admin', 'close')
    const line = (await f.repo.read(t.id)).closure?.refunds[0]
    expect(line).toMatchObject({
      method: 'SIMULATED_MONEY',
      status: 'REFUNDED',
      receipt: { realMoneyMoved: false },
    })
    expect(f.wallet.debits).toBe(0)
    expect(f.wallet.refunds).toBe(0)
  })

  it('un torneo que ya confirmó campeón conserva su final y no devuelve inscripciones', async () => {
    const f = fixture(),
      t = await f.create(),
      lifecycle = new InMemoryLifecycleRepository()
    await f.confirm(t.id)
    await lifecycle.change(t.id, (s) => {
      s.champion = {
        teamId: 'champion',
        teamName: 'Campeón',
        memberIds: ['p0', 'q0'],
        heroes: [],
        finalEncounterId: 'Final',
        finalRoomId: 'room',
        declaredAt: f.clock.now().toISOString(),
      }
    })
    f.setNow('2026-10-13T00:00:00Z')
    const close = new TournamentClosures(f.repo, lifecycle, f.wallet, f.clock)
    await close.sweep()
    await expect(close.close(t.id, 'admin', 'close')).rejects.toMatchObject({
      code: 'TOURNAMENT_COMPLETED',
    })
    expect((await f.repo.read(t.id)).closure).toBeUndefined()
    expect(f.wallet.refunds).toBe(0)
  })
})
