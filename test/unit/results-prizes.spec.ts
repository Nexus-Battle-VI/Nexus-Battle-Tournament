import { InMemoryLifecycleRepository } from '../../src/adapters/outbound/persistence/InMemoryLifecycleRepository'
import { Progressions } from '../../src/application/use-cases/Progressions'
import { Prizes } from '../../src/application/use-cases/Prizes'
import { RegistrationError } from '../../src/domain/registration'
import { ControlledMatchRead, publishedFixture, matchFixture } from '../support/match-read-fixture'
import type { MatchId } from '../../src/domain/bracket'
import type { PrizeGrant } from '../../src/domain/prize'

export const PRIZE_FIXTURE = {
  operationId: 'fixture-approval',
  allocations: [
    { memberIndex: 0, credits: '501', epicProductId: 'fixture-only-product' },
    { memberIndex: 1, credits: '499', epicProductId: null },
  ],
}
describe('HU-80/86: consumidores controlados; no acredita HU-85 ni destino real', () => {
  const setup = async () => {
    const f = await publishedFixture(),
      source = new ControlledMatchRead(),
      lifecycle = new InMemoryLifecycleRepository()
    const progress = new Progressions(lifecycle, f.repo, source, f.clock)
    const finish = async (label: MatchId, winner: string | null = 'A') => {
      const e = matchFixture(
        f.tournament.bracket!,
        label,
        (await lifecycle.read(f.id)).results,
        winner,
      )
      source.items.set(e.encounterId, e)
      await progress.confirm(f.id, e.encounterId)
      return e
    }
    const finishAll = async () => {
      for (const m of f.tournament.bracket!.matches) await finish(m.id)
    }
    return { ...f, source, lifecycle, progress, finish, finishAll }
  }
  it('E2 antes de E1 espera ambos, usa ids opacos, avanza ganadores/perdedores y no cambia snapshot', async () => {
    const f = await setup(),
      before = await f.repo.read(f.id)
    await f.finish('E2')
    expect((await f.progress.bracket(f.id))!.matches.find((m) => m.id === 'E5')!.status).toBe(
      'WAITING',
    )
    await f.finish('E1')
    const projected = (await f.progress.view(f.id)).bracket!
    expect(projected.matches.find((m) => m.id === 'E5')!.teamIds).toEqual([
      before.bracket!.seeds[0]!.teamId,
      before.bracket!.seeds[2]!.teamId,
    ])
    expect(projected.matches.find((m) => m.id === 'E7')!.teamIds).toEqual([
      before.bracket!.seeds[1]!.teamId,
      before.bracket!.seeds[3]!.teamId,
    ])
    expect(projected.matches.find((m) => m.id === 'E5')!.status).toBe('READY')
    expect(await f.repo.read(f.id)).toEqual(before)
    expect(f.source.read.mock.calls.every(([, id]) => id !== 'E1' && id !== 'E2')).toBe(true)
    await expect(f.progress.confirm(f.id, 'E1')).rejects.toMatchObject({ status: 404 })
  })
  it('concurrencia y duplicados no multiplican resultados; mapea por miembros aunque invierta equipos', async () => {
    const f = await setup()
    const e1 = matchFixture(f.tournament.bracket!, 'E1'),
      e2 = matchFixture(f.tournament.bracket!, 'E2')
    e1.teams = [...e1.teams].reverse()
    f.source.items.set(e1.encounterId, e1)
    f.source.items.set(e2.encounterId, e2)
    await Promise.all([
      f.progress.confirm(f.id, e1.encounterId),
      f.progress.confirm(f.id, e2.encounterId),
    ])
    await Promise.all(Array.from({ length: 3 }, () => f.progress.confirm(f.id, e1.encounterId)))
    expect((await f.lifecycle.read(f.id)).results).toHaveLength(2)
    expect(
      (await f.lifecycle.read(f.id)).results.find((r) => r.matchId === 'E1')!.winnerTeamId,
    ).toBe(f.tournament.bracket!.seeds[0]!.teamId)
  })
  it.each([
    'room',
    'tournament',
    'gap',
    'cursor',
    'terminal',
    'roster',
    'winner',
    'closed',
    'round',
    'heroes',
  ])('rechaza %s sin alterar progreso', async (kind) => {
    const f = await setup(),
      e = matchFixture(f.tournament.bracket!)
    if (kind === 'room') (e.events[0]!.payload as Record<string, unknown>).roomId = 'foreign'
    if (kind === 'tournament') e.tournamentId = 'foreign'
    if (kind === 'gap') e.events = e.events.slice(1)
    if (kind === 'cursor') e.engineLastSeq = 121
    if (kind === 'terminal')
      (e.events.at(-1)!.payload as Record<string, unknown>).result = {
        ...e.result,
        reason: 'TIME_LIMIT',
      }
    if (kind === 'roster')
      e.teams = [
        {
          ...e.teams[0]!,
          participants: [{ playerId: 'foreign', heroId: 'foreign' }, e.teams[0]!.participants[1]!],
        },
        e.teams[1]!,
      ]
    if (kind === 'winner') e.result!.winnerTeamLabel = 'foreign'
    if (kind === 'closed') e.closedAt = '2026-10-12T12:09:00.000Z'
    if (kind === 'round') e.round = 99
    if (kind === 'heroes')
      e.teams = [
        {
          ...e.teams[0]!,
          participants: e.teams[0]!.participants.map((p) => ({ ...p, heroId: 'same' })),
        },
        e.teams[1]!,
      ]
    f.source.items.set(e.encounterId, e)
    if (kind === 'tournament')
      await expect(f.progress.confirm(f.id, e.encounterId)).rejects.toMatchObject({ status: 404 })
    else
      await expect(f.progress.confirm(f.id, e.encounterId)).rejects.toMatchObject({
        code: 'RESULT_INCOMPATIBLE',
      })
    expect((await f.lifecycle.read(f.id)).results).toEqual([])
  })
  it('NO_WINNER exige resolución, no inventa avance ni campeón', async () => {
    const f = await setup()
    await f.finish('E1', null)
    await f.finish('E2')
    const view = await f.progress.view(f.id)
    expect(view.bracket!.matches.find((m) => m.id === 'E1')!.status).toBe('RESOLUTION_REQUIRED')
    expect(view.bracket!.matches.find((m) => m.id === 'E5')!.status).toBe('WAITING')
    expect(view.champion).toBeNull()
  })
  it('un campeón tras todas las dependencias y final; reinicio conserva el mismo resultado', async () => {
    const f = await setup()
    await f.finishAll()
    const state = await f.lifecycle.read(f.id),
      champion = state.champion!
    expect(champion.memberIds).toEqual(f.tournament.bracket!.seeds[0]!.memberIds)
    expect(champion.finalEncounterId).toBe(f.tournament.bracket!.matches.at(-1)!.encounterId)
    const restarted = new Progressions(f.lifecycle, f.repo, f.source, f.clock)
    await restarted.reconcile()
    expect(await f.lifecycle.read(f.id)).toEqual(state)
    expect((await restarted.view(f.id)).eliminatedTeamIds).toHaveLength(7)
    expect(champion.heroes.map((h) => h.playerId)).toEqual(champion.memberIds)
  })
  it('sin aprobación/campeón no envía; cuerpo manipulado y política implícita se rechazan', async () => {
    const f = await setup(),
      grant = jest.fn(),
      prizes = new Prizes(f.lifecycle, f.repo, { grant }, f.clock)
    await expect(prizes.deliver(f.id, 'admin')).rejects.toMatchObject({ code: 'CHAMPION_REQUIRED' })
    await f.finishAll()
    await expect(prizes.deliver(f.id, 'admin')).rejects.toMatchObject({
      code: 'PRIZE_NOT_APPROVED',
    })
    for (const command of [
      { ...PRIZE_FIXTURE, championTeamId: 'foreign' },
      { ...PRIZE_FIXTURE, playerId: 'foreign' },
      {
        ...PRIZE_FIXTURE,
        allocations: PRIZE_FIXTURE.allocations.map((a) => ({ ...a, heroId: 'foreign' })),
      },
      {
        ...PRIZE_FIXTURE,
        allocations: PRIZE_FIXTURE.allocations.map((a) => ({ ...a, credits: '1.5' })),
      },
      {
        ...PRIZE_FIXTURE,
        allocations: PRIZE_FIXTURE.allocations.map((a) => ({ ...a, epicProductId: null })),
      },
      {
        ...PRIZE_FIXTURE,
        allocations: PRIZE_FIXTURE.allocations.map((a) => ({ ...a, credits: '9007199254740992' })),
      },
    ])
      await expect(prizes.approve(f.id, 'admin', command)).rejects.toMatchObject({ status: 400 })
    expect(grant).not.toHaveBeenCalled()
    await prizes.approve(f.id, 'admin', PRIZE_FIXTURE)
    const before = await prizes.view(f.id)
    await prizes.approve(f.id, 'admin', PRIZE_FIXTURE)
    expect(await prizes.view(f.id)).toEqual(before)
    await expect(
      prizes.approve(f.id, 'admin', { ...PRIZE_FIXTURE, operationId: 'other' }),
    ).rejects.toMatchObject({ status: 409 })
  })
  it('créditos entregados/épica pendiente, respuesta perdida, reinicio y recibos idénticos sin reenviar confirmados', async () => {
    const f = await setup()
    await f.finishAll()
    const movements = new Map<string, unknown>()
    let failEpic = true,
      lose = true
    const grant = jest.fn(async (c: PrizeGrant) => {
      expect(
        (await f.lifecycle.read(f.id)).delivery!.lines.some((l) => l.operationId === c.operationId),
      ).toBe(true)
      if (c.kind === 'EPIC' && failEpic) throw new Error('unavailable')
      const receipt = movements.get(c.operationId) ?? {
        ...c,
        status: 'DELIVERED',
        receiptId: 'fixture-receipt:' + c.operationId,
      }
      movements.set(c.operationId, receipt)
      if (lose) {
        lose = false
        throw new Error('response lost after commit')
      }
      return receipt
    })
    let prizes = new Prizes(f.lifecycle, f.repo, { grant }, f.clock)
    await prizes.approve(f.id, 'admin', PRIZE_FIXTURE)
    expect((await prizes.deliver(f.id, 'admin')).delivery!.status).toBe('PARTIAL')
    prizes = new Prizes(f.lifecycle, f.repo, { grant }, f.clock)
    await prizes.reconcile()
    expect((await prizes.view(f.id)).delivery!.status).toBe('PARTIAL')
    failEpic = false
    await prizes.reconcile()
    const complete = await prizes.view(f.id),
      calls = grant.mock.calls.length
    await prizes.deliver(f.id, 'admin')
    await prizes.reconcile()
    expect(grant).toHaveBeenCalledTimes(calls)
    expect(await prizes.view(f.id)).toEqual(complete)
    expect(complete.delivery!.status).toBe('COMPLETED')
    expect(movements.size).toBe(3)
  })
  it('409 queda para revisión; no cambia operationId ni reintenta automáticamente', async () => {
    const f = await setup()
    await f.finishAll()
    const grant = jest.fn(() =>
      Promise.reject(new RegistrationError('PRIZE_DESTINATION_CONFLICT', 'conflict', 503)),
    )
    const prizes = new Prizes(f.lifecycle, f.repo, { grant }, f.clock)
    await prizes.approve(f.id, 'admin', PRIZE_FIXTURE)
    await prizes.deliver(f.id, 'admin')
    const before = await prizes.view(f.id),
      calls = grant.mock.calls.length
    await prizes.reconcile()
    await prizes.deliver(f.id, 'admin')
    expect(grant).toHaveBeenCalledTimes(calls)
    expect(await prizes.view(f.id)).toEqual(before)
    expect(await f.lifecycle.pendingDeliveries()).toEqual([])
  })
  it('entrega concurrente comparte intenciones y rechaza recibos incompatibles', async () => {
    const f = await setup()
    await f.finishAll()
    const grant = jest.fn((c: PrizeGrant) =>
      Promise.resolve({ ...c, status: 'DELIVERED', receiptId: 'receipt:' + c.operationId }),
    )
    const a = new Prizes(f.lifecycle, f.repo, { grant }, f.clock),
      b = new Prizes(f.lifecycle, f.repo, { grant }, f.clock)
    await a.approve(f.id, 'admin', PRIZE_FIXTURE)
    await Promise.all([a.deliver(f.id, 'admin'), b.deliver(f.id, 'admin')])
    expect((await a.view(f.id)).delivery!.status).toBe('COMPLETED')
    expect(new Set(grant.mock.calls.map(([c]) => JSON.stringify(c))).size).toBe(3)
  })
})
