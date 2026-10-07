import { acceptanceFixture } from '../support/acceptance-fixture'
import { matchFixture } from '../support/match-read-fixture'
import { CombatRejectedError } from '../../src/domain/encounter-admin'
import { Prizes } from '../../src/application/use-cases/Prizes'
import { roundWindows } from '../../src/domain/match-acceptance'
import { UnavailableTournamentPrizeRecipients } from '../../src/adapters/outbound/system/UnavailableTournamentPrizeRecipients'

describe('HU-85 v3: reloj, aceptación individual, decisión durable y avance por ausencia', () => {
  it('guarda seis ventanas UTC; cierre exacto excluye aceptación, replay mantiene recibo y timestamp', async () => {
    const f = await acceptanceFixture(),
      id = f.e().encounterId,
      subject = f.b.seeds[0]!.memberIds[0]!
    expect(f.t.roundSchedule).toEqual(roundWindows(f.t.startsAt))
    expect(f.t.roundSchedule.map((w) => w.scheduledStartAt)).toEqual(
      Array.from({ length: 6 }, (_, i) =>
        new Date(new Date(f.t.startsAt).getTime() + 120000 + i * 600000).toISOString(),
      ),
    )
    await expect(f.acceptance.accept(f.id, id, subject, 'early')).rejects.toMatchObject({
      code: 'ACCEPTANCE_NOT_OPEN',
    })
    f.setOpen()
    await expect(f.acceptance.accept(f.id, id, 'outsider', 'outside')).rejects.toMatchObject({
      status: 403,
    })
    const accepted = await f.acceptance.accept(f.id, id, subject, 'once')
    expect(await f.acceptance.accept(f.id, id, subject, 'again')).toEqual({
      ...accepted,
      replayed: true,
    })
    await expect(
      f.acceptance.accept(f.id, id, f.b.seeds[1]!.memberIds[0]!, 'once'),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
    await f.setClose()
    await expect(
      f.acceptance.accept(f.id, id, f.b.seeds[1]!.memberIds[0]!, 'late'),
    ).rejects.toMatchObject({ code: 'ACCEPTANCE_CLOSED' })
    await f.reconciliation.run(f.id, id)
    expect(await f.acceptance.accept(f.id, id, subject, 'once')).toEqual({
      ...accepted,
      replayed: true,
    })
    expect((await f.store.read(f.id, id))!.acceptances).toHaveLength(1)
    expect((await f.acceptance.view(f.id, id, subject))!.myAcceptance!.receiptId).toBe(
      accepted.receiptId,
    )
    expect(f.commands.createRoom).not.toHaveBeenCalled()
  })
  it.each([
    { a: 3, b: 2, rule: 'COMPLETE_TEAM' },
    { a: 1, b: 2, rule: 'MORE_ACCEPTANCES' },
    { a: 2, b: 0, rule: 'MORE_ACCEPTANCES' },
  ])('decide $a–$b sin sorteo ni sala', async ({ a, b, rule }) => {
    const f = await acceptanceFixture()
    f.setOpen()
    await f.acceptSide('E1', 0, a)
    await f.acceptSide('E1', 1, b)
    await f.setClose()
    await f.reconciliation.run(f.id, f.e().encounterId)
    const state = await f.store.read(f.id, f.e().encounterId)
    expect(state!.resolution).toMatchObject({
      rule,
      acceptedCounts: [a, b],
      coinBit: null,
      combatRoomId: null,
      winnerTeamId: f.b.seeds[a > b ? 0 : 1]!.teamId,
    })
    const confirmed = await f.lifecycle.read(f.id)
    expect(confirmed.results).toHaveLength(1)
    expect(confirmed.results[0]!.result).toBeNull()
    expect(confirmed.results[0]!.source).toBe('TOURNAMENT')
    expect(f.random.bit).not.toHaveBeenCalled()
    expect(f.commands.createRoom).not.toHaveBeenCalled()
    await f.worker().run(f.id, f.e().encounterId)
    expect(await f.lifecycle.read(f.id)).toEqual(confirmed)
    expect((await f.progress.view(f.id)).statistics.reduce((n, s) => n + s.victories, 0)).toBe(1)
  })
  it.each([0, 1, 2].flatMap((count) => [0, 1].map((bit) => ({ count, bit }))))(
    'empate $count–$count conserva el bit $bit con dos workers',
    async ({ count, bit }) => {
      const f = await acceptanceFixture()
      f.random.bit.mockReturnValue(bit === 0 ? 0 : 1)
      f.setOpen()
      await f.acceptSide('E1', 0, count)
      await f.acceptSide('E1', 1, count)
      await f.setClose()
      await Promise.all([
        f.worker().run(f.id, f.e().encounterId),
        f.worker().run(f.id, f.e().encounterId),
      ])
      const state = await f.store.read(f.id, f.e().encounterId)
      expect(state!.resolution).toMatchObject({
        rule: 'FAIR_COIN',
        coinBit: bit,
        winnerTeamId: f.b.seeds[bit]!.teamId,
      })
      expect(f.random.bit).toHaveBeenCalledTimes(1)
      f.random.bit.mockReturnValue(bit === 0 ? 1 : 0)
      await f.worker().run(f.id, f.e().encounterId)
      expect(await f.store.read(f.id, f.e().encounterId)).toEqual(state)
      expect(f.random.bit).toHaveBeenCalledTimes(1)
    },
  )
  it('ambos completos esperan cierre; dos workers recuperan una intención y auditada sin dependencia de transmisión', async () => {
    const f = await acceptanceFixture()
    f.setOpen()
    await f.acceptSide()
    await f.acceptSide('E1', 1)
    await expect(
      f.administration.prepare(f.id, f.e().encounterId, 'admin', 'early'),
    ).rejects.toMatchObject({ code: 'ACCEPTANCE_REQUIRED' })
    await f.reconciliation.run(f.id, f.e().encounterId)
    expect(f.commands.createRoom).not.toHaveBeenCalled()
    await f.setClose()
    await Promise.all([
      f.worker().run(f.id, f.e().encounterId),
      f.worker().run(f.id, f.e().encounterId),
    ])
    expect(f.commands.createRoom).toHaveBeenCalledTimes(1)
    expect(f.commands.startRoom).toHaveBeenCalledTimes(1)
    expect(f.commands.createRoom.mock.calls[0]![0]).toMatchObject({
      tournamentMode: 'TRIO',
      teamSize: 3,
    })
    expect(f.commands.createRoom.mock.calls[0]![0].teams.flatMap((t) => t.memberIds)).toHaveLength(
      6,
    )
    expect((await f.store.read(f.id, f.e().encounterId))!.combatIntent!.phase).toBe('STARTED')
    expect((await f.actions.list(f.id)).map((a) => a.actor)).toEqual([
      'tournament-worker',
      'tournament-worker',
    ])
    expect((await f.encounters.findOne(f.id, f.e().encounterId))!.startedAt).toBeNull()
    expect(f.random.bit).not.toHaveBeenCalled()
    expect((await f.lifecycle.read(f.id)).results).toEqual([])
  })
  it('falta de dependencias a apertura bloquea aunque después se resuelvan; no abre ventana tardía', async () => {
    const f = await acceptanceFixture()
    f.setOpen(2)
    await f.reconciliation.run(f.id, f.e('E5').encounterId)
    expect((await f.store.read(f.id, f.e('E5').encounterId))!.blocker!.code).toBe(
      'DEPENDENCIES_DELAYED',
    )
    for (const label of ['E1', 'E2'] as const) {
      const e = matchFixture(f.b, label)
      f.source.items.set(e.encounterId, e)
      await f.progress.confirm(f.id, e.encounterId)
    }
    await expect(
      f.acceptance.accept(f.id, f.e('E5').encounterId, f.b.seeds[0]!.memberIds[0]!, 'late'),
    ).rejects.toMatchObject({ code: 'ACCEPTANCE_CLOSED' })
    await f.setClose(2)
    await f.reconciliation.run(f.id, f.e('E5').encounterId)
    expect((await f.store.read(f.id, f.e('E5').encounterId))!.resolution).toBeNull()
    expect(f.commands.createRoom).not.toHaveBeenCalled()
    expect(f.random.bit).not.toHaveBeenCalled()
  })
  it('reinicio que perdió toda la ventana deja incidencia visible; no fabrica ausencia 0–0', async () => {
    const f = await acceptanceFixture()
    await f.setClose()
    await f.reconciliation.run(f.id, f.e().encounterId)
    expect((await f.store.read(f.id, f.e().encounterId))!).toMatchObject({
      phase: 'BLOCKED',
      decision: null,
      resolution: null,
      blocker: { code: 'WINDOW_MISSED' },
    })
    expect(f.random.bit).not.toHaveBeenCalled()
    expect(f.commands.startRoom).not.toHaveBeenCalled()
  })
  it('reinicio durante ventana abierta conserva aceptaciones y bloquea la incertidumbre operativa sin ganador', async () => {
    const f = await acceptanceFixture()
    f.setOpen()
    await f.acceptSide('E1', 0, 1)
    // Caída de servidor durante la ventana, sin los ticks sanos que representa setClose.
    f.setNow(f.window().acceptanceClosesAt)
    await f.worker().run(f.id, f.e().encounterId)
    expect(await f.store.read(f.id, f.e().encounterId)).toMatchObject({
      phase: 'BLOCKED',
      resolution: null,
      decision: null,
      blocker: { code: 'WINDOW_INTERRUPTED' },
    })
    expect((await f.store.read(f.id, f.e().encounterId))!.acceptances).toHaveLength(1)
    expect(f.random.bit).not.toHaveBeenCalled()
    expect((await f.lifecycle.read(f.id)).results).toEqual([])
  })
  it('NO_WINNER del registro validado conserva resolución PLAYED y no se sortea como ausencia', async () => {
    const f = await acceptanceFixture()
    const e = matchFixture(f.b, 'E1', [], null)
    f.source.items.set(e.encounterId, e)
    await f.progress.confirm(f.id, e.encounterId)
    const view = await f.acceptance.view(f.id, e.encounterId)
    expect(view!.resolution).toMatchObject({
      resultType: 'PLAYED',
      winnerTeamId: null,
      loserTeamId: null,
      combatRoomId: e.combatRoomId,
      combatResult: { outcome: 'NO_WINNER' },
    })
    expect((await f.progress.view(f.id)).bracket!.matches.find((m) => m.id === 'E1')!.status).toBe(
      'RESOLUTION_REQUIRED',
    )
    expect(f.random.bit).not.toHaveBeenCalled()
  })
  it('un reinicio corto no cierra la ventana: todavía acepta; ambos completos combaten al deadline sin exigir latidos', async () => {
    const f = await acceptanceFixture(),
      e = f.e().encounterId
    f.setOpen()
    await f.acceptSide('E1', 0, 2)
    f.setNow(new Date(new Date(f.window().acceptanceOpensAt).getTime() + 10_000).toISOString())
    expect((await f.acceptance.view(f.id, e))!.acceptanceStatus).toBe('OPEN')
    await f.acceptSide('E1', 0, 3)
    await f.acceptSide('E1', 1, 3)
    f.setNow(f.window().acceptanceClosesAt)
    expect((await f.acceptance.view(f.id, e))!.acceptanceStatus).toBe('CLOSED')
    await f.worker().run(f.id, e)
    expect(await f.store.read(f.id, e)).toMatchObject({
      phase: 'CLOSED',
      decision: 'COMBAT',
      resolution: null,
      combatIntent: { phase: 'STARTED' },
    })
    expect(f.commands.startRoom).toHaveBeenCalledTimes(1)
  })
  it.each(['prepare', 'start', 'eligibility'])(
    'fallo de %s conserva intención y no produce derrota; reinicio recupera IDs',
    async (kind) => {
      const f = await acceptanceFixture()
      f.setOpen()
      await f.acceptSide()
      await f.acceptSide('E1', 1)
      await f.setClose()
      const rooms = new Set<string>(),
        battles = new Set<string>()
      let lose = true
      f.commands.createRoom.mockImplementation((c) => {
        rooms.add(c.operationId)
        if (lose && kind !== 'start') {
          lose = false
          return Promise.reject(
            kind === 'eligibility'
              ? new CombatRejectedError('Inelegible', [{ code: 'NO_HERO' }])
              : new Error('Respuesta perdida tras preparar'),
          )
        }
        return Promise.resolve({ roomId: 'stable-room' })
      })
      f.commands.startRoom.mockImplementation((_room, c) => {
        battles.add(c.operationId)
        if (lose && kind === 'start') {
          lose = false
          return Promise.reject(new Error('Respuesta perdida tras iniciar'))
        }
        return Promise.resolve()
      })
      await f.worker().run(f.id, f.e().encounterId)
      const pending = await f.store.read(f.id, f.e().encounterId)
      expect(pending!.resolution).toBeNull()
      expect(pending!.blocker!.responsible).toBe('COMBAT_OPERATIONS')
      await f.worker().run(f.id, f.e().encounterId)
      expect(rooms.size).toBe(1)
      expect(battles.size).toBe(1)
      expect((await f.store.read(f.id, f.e().encounterId))!.combatIntent!.phase).toBe('STARTED')
      const calls = f.commands.createRoom.mock.calls.length + f.commands.startRoom.mock.calls.length
      await f.worker().run(f.id, f.e().encounterId)
      expect(f.commands.createRoom.mock.calls.length + f.commands.startRoom.mock.calls.length).toBe(
        calls,
      )
      expect((await f.lifecycle.read(f.id)).results).toEqual([])
    },
  )
  it('ausencias recorren ambos destinos del grafo, una Final declara campeón de tres y deja premios pendientes', async () => {
    const f = await acceptanceFixture()
    for (let round = 1; round <= 6; round++) {
      f.setOpen(round)
      await f.reconciliation.sweep()
      expect((await f.progress.view(f.id)).champion).toBeNull()
      await f.setClose(round)
      await f.reconciliation.sweep()
    }
    const state = await f.lifecycle.read(f.id),
      view = await f.progress.view(f.id)
    expect(state.results).toHaveLength(14)
    expect(state.champion!.memberIds).toHaveLength(3)
    expect(state.champion!.finalRoomId).toBeNull()
    expect(state.champion!.heroes).toEqual([])
    expect(view.bracket!.matches.find((m) => m.id === 'E9')!.teamIds).toEqual([
      state.results.find((r) => r.matchId === 'E6')!.loserTeamId,
      state.results.find((r) => r.matchId === 'E7')!.winnerTeamId,
    ])
    expect(view.bracket!.matches.find((m) => m.id === 'E10')!.teamIds).toEqual([
      state.results.find((r) => r.matchId === 'E5')!.loserTeamId,
      state.results.find((r) => r.matchId === 'E8')!.winnerTeamId,
    ])
    expect(view.bracket!.matches.find((m) => m.id === 'Final')!.teamIds).toEqual([
      state.results.find((r) => r.matchId === 'E11')!.winnerTeamId,
      state.results.find((r) => r.matchId === 'E13')!.winnerTeamId,
    ])
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
    const defaultRecipients = new Prizes(
      f.lifecycle,
      f.repo,
      { grant },
      f.clock,
      new UnavailableTournamentPrizeRecipients(),
    )
    expect(
      (await defaultRecipients.deliver(f.id, 'admin')).delivery!.lines.every(
        (l) => l.lastError === 'PRIZE_RECIPIENT_CONTRACT_REQUIRED',
      ),
    ).toBe(true)
    const pending = await prizes.deliver(f.id, 'admin')
    expect(pending.delivery!.lines).toHaveLength(4)
    expect(pending.delivery!.status).toBe('PENDING')
    expect(pending.delivery!.lines.every((l) => l.lastError === 'PRIZE_RECIPIENT_REQUIRED')).toBe(
      true,
    )
    heroFor.mockImplementation(() => Promise.resolve('authoritative-hero'))
    await prizes.reconcile()
    expect(
      (await prizes.view(f.id)).delivery!.lines.every(
        (l) => l.lastError === 'PRIZE_RESOLUTION_CONTRACT_REQUIRED',
      ),
    ).toBe(true)
    expect(grant).not.toHaveBeenCalled()
    await f.reconciliation.sweep()
    expect((await f.lifecycle.read(f.id)).results).toHaveLength(14)
    expect((await f.progress.view(f.id)).statistics.reduce((n, s) => n + s.victories, 0)).toBe(14)
    expect((await f.repo.read(f.id)).bracket).toEqual(f.b)
  })
})
