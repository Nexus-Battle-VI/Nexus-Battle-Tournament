import { Broadcasts } from '../../src/application/use-cases/Broadcasts'
import { broadcastFixture } from '../support/broadcast-fixture'
import { matchFixture, publishedFixture } from '../support/match-read-fixture'
import { broadcastSnapshot } from '../../src/domain/broadcast'
interface FixtureWire {
  battle: {
    battleId: string
    turnOrder: { playerId: string }[]
    currentTurn: { position: number }
    combatants: { health: { current: number; max: number } | null; power?: unknown }[]
  }
}

describe('HU-79/81: consumo observable controlado, sin acciones HU-85', () => {
  it.each(['SOLO', 'DUO', 'TRIO'] as const)(
    'muestra el roster completo %s y rechaza recortarlo',
    async (mode) => {
      const f = await publishedFixture(undefined, mode)
      const e = matchFixture(f.tournament.bracket!, 'E1', [], null, false, 1)
      const snapshot = broadcastSnapshot(e, f.tournament, f.clock.now().toISOString())
      expect(snapshot.combatants).toHaveLength(f.tournament.teamSize! * 2)
      expect(snapshot.combatants.map((c) => c.playerId)).toEqual(
        e.teams.flatMap((t) => t.participants.map((p) => p.playerId)),
      )
      const truncated = {
        ...e,
        teams: e.teams.map((team, index) =>
          index === 0 ? { ...team, participants: team.participants.slice(1) } : team,
        ),
      }
      expect(() =>
        broadcastSnapshot(truncated, f.tournament, f.clock.now().toISOString()),
      ).toThrow()
    },
  )
  it('un transmisor concurrente, revisión, replay y sustitución revocan al anterior', async () => {
    const f = await broadcastFixture(),
      outcomes = await Promise.allSettled([
        f.service.designate(f.id, 'A'),
        f.service.designate(f.id, 'B'),
      ])
    expect(outcomes.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    const original = await f.service.configuration(f.id),
      other = original.broadcasterId === 'A' ? 'B' : 'A'
    expect(await f.service.designate(f.id, original.broadcasterId!)).toEqual(original)
    await expect(f.service.designate(f.id, other)).rejects.toMatchObject({ status: 409 })
    await f.service.designate(f.id, other, original.revision)
    await expect(f.service.observe(f.id, original.broadcasterId!)).rejects.toMatchObject({
      status: 403,
    })
    await expect(f.service.designate(f.id, 'C', original.revision)).rejects.toMatchObject({
      status: 409,
    })
  })
  it('expone solo vida/poder/turno/equipos/héroes permitidos y conserva ids opacos', async () => {
    const f = await broadcastFixture()
    await f.service.designate(f.id, 'A')
    const view = await f.service.select(f.id, f.e1.encounterId, 'A', 1)
    expect(view.snapshot).toMatchObject({
      matchId: f.e1.encounterId,
      encounterId: f.e1.encounterId,
      bracketLabel: 'E1',
      combatRoomId: f.e1.combatRoomId,
      status: 'IN_PROGRESS',
    })
    expect(view.snapshot.combatants).toHaveLength(4)
    expect(view.snapshot.combatants[0]!.health).toEqual({ current: 90, max: 100 })
    expect(JSON.stringify(view)).not.toMatch(
      /must-not-be-exposed|private-action|token|internalSeed/u,
    )
    expect((await f.service.active(f.id, 'A')).matches.map((e) => e.matchId)).toEqual([
      f.e1.encounterId,
      f.e2.encounterId,
    ])
    expect(f.source.items.size).toBe(2)
  })
  it('cambio E1→E2 descarta respuesta tardía de E1; no muta sus archivos', async () => {
    const f = await broadcastFixture()
    await f.service.designate(f.id, 'A')
    await f.service.select(f.id, f.e1.encounterId, 'A', 1)
    let release!: (x: typeof f.e1) => void
    f.source.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const old = f.service.observe(f.id, 'A'),
      rejection = expect(old).rejects.toMatchObject({ code: 'BROADCAST_CHANGED' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const selected = await f.service.select(f.id, f.e2.encounterId, 'A', 2)
    release(f.e1)
    await rejection
    expect((await f.service.observe(f.id, 'A')).state).toEqual(selected.state)
    expect((await f.service.observe(f.id, 'A')).snapshot!.matchId).toBe(f.e2.encounterId)
    expect(f.e1.status).toBe('IN_PROGRESS')
  })
  it('selección inválida/ajena/desconectada conserva la previa; final permanece y replay no reinicia', async () => {
    const f = await broadcastFixture()
    await f.service.designate(f.id, 'A')
    await f.service.select(f.id, f.e1.encounterId, 'A', 1)
    const finished = matchFixture(f.tournament.bracket!, 'E2')
    f.source.items.set(finished.encounterId, finished)
    await expect(f.service.select(f.id, finished.encounterId, 'A', 2)).rejects.toMatchObject({
      code: 'MATCH_NOT_ACTIVE',
    })
    await expect(f.service.select(f.id, 'E1', 'A', 2)).rejects.toMatchObject({ status: 404 })
    await expect(f.service.select(f.id, f.e2.encounterId, 'other', 2)).rejects.toMatchObject({
      status: 403,
    })
    f.source.read.mockRejectedValueOnce(new Error('offline'))
    await expect(f.service.select(f.id, f.e2.encounterId, 'A', 2)).rejects.toMatchObject({
      status: 503,
    })
    expect((await f.service.configuration(f.id)).selectedMatchId).toBe(f.e1.encounterId)
    const terminal = matchFixture(f.tournament.bracket!, 'E1', [], null)
    f.source.items.set(terminal.encounterId, terminal)
    const restarted = new Broadcasts(f.repository, f.repo, f.source, f.clock)
    expect((await restarted.observe(f.id, 'A')).snapshot!.result!.outcome).toBe('NO_WINNER')
    expect((await restarted.select(f.id, f.e1.encounterId, 'A', 2)).state.revision).toBe(2)
    f.source.items.set(f.e2.encounterId, f.e2)
    await restarted.select(f.id, f.e2.encounterId, 'A', 2)
    expect((await restarted.configuration(f.id)).selectedMatchId).toBe(f.e2.encounterId)
  })
  it('revocación durante lectura rechaza devolución al antiguo transmisor', async () => {
    const f = await broadcastFixture()
    await f.service.designate(f.id, 'A')
    await f.service.select(f.id, f.e1.encounterId, 'A', 1)
    let release!: (x: typeof f.e1) => void
    f.source.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const pending = f.service.observe(f.id, 'A'),
      denied = expect(pending).rejects.toMatchObject({ status: 403 })
    await new Promise<void>((resolve) => setImmediate(resolve))
    await f.service.designate(f.id, 'B', 2)
    release(f.e1)
    await denied
    expect((await f.service.configuration(f.id)).selectedMatchId).toBe(f.e1.encounterId)
  })
  it('lista desconectada devuelve 503 y conserva la selección', async () => {
    const f = await broadcastFixture()
    await f.service.designate(f.id, 'A')
    await f.service.select(f.id, f.e1.encounterId, 'A', 1)
    f.source.list.mockRejectedValueOnce(new Error('offline'))
    await expect(f.service.active(f.id, 'A')).rejects.toMatchObject({
      status: 503,
      code: 'COMBAT_UNAVAILABLE',
    })
    expect((await f.service.configuration(f.id)).selectedMatchId).toBe(f.e1.encounterId)
  })
  it.each(['battle', 'room', 'order', 'turn', 'meters', 'roster', 'cursor'])(
    'estado visible inválido %s produce 503',
    async (kind) => {
      const f = await broadcastFixture(),
        e = structuredClone(f.e1),
        payload = e.events[0]!.payload as FixtureWire,
        battle = payload.battle
      if (kind === 'battle') payload.battle = {} as FixtureWire['battle']
      if (kind === 'room') battle.battleId = 'foreign'
      if (kind === 'order') battle.turnOrder[0]!.playerId = 'foreign'
      if (kind === 'turn') battle.currentTurn = { ...battle.currentTurn, position: 99 }
      if (kind === 'meters') battle.combatants[0]!.health!.current = 999
      if (kind === 'roster') e.teams = [e.teams[0]!]
      if (kind === 'cursor') e.engineLastSeq = 2
      expect(() => broadcastSnapshot(e, f.tournament, f.clock.now().toISOString())).toThrow()
    },
  )
  it('medidores legítimamente ausentes son null y sin selección no inventa captura', async () => {
    const f = await broadcastFixture()
    await f.service.designate(f.id, 'A')
    expect((await f.service.observe(f.id, 'A')).snapshot).toBeNull()
    const wire = f.e1.events[0]!.payload as FixtureWire
    wire.battle.combatants[0]!.health = null
    delete wire.battle.combatants[0]!.power
    expect(
      (await f.service.select(f.id, f.e1.encounterId, 'A', 1)).snapshot.combatants[0],
    ).toMatchObject({ health: null, power: null })
  })
})
