import { acceptanceDeadline, decideAbsence, type AbsenceTeam } from '../../src/domain/absence'

const team = (id: string, size: number): AbsenceTeam => ({
  teamId: id,
  memberIds: Array.from({ length: size }, (_, n) => `${id}-${String(n)}`),
})
const ids = (id: string, count: number): string[] =>
  Array.from({ length: count }, (_, n) => `${id}-${String(n)}`)

describe('regla de ausencia (decisión de Carlos sobre HU-85)', () => {
  it('la ventana dura exactamente dos minutos desde la hora programada', () => {
    expect(acceptanceDeadline(new Date('2026-10-12T19:00:00Z')).toISOString()).toBe(
      '2026-10-12T19:02:00.000Z',
    )
  })

  it.each([1, 2, 3])(
    '%i contra %i: si ambos equipos están completos no hay avance por ausencia',
    (size) => {
      const a = team('A', size)
      const b = team('B', size)
      expect(
        decideAbsence([a, b], new Set([...ids('A', size), ...ids('B', size)]), () => 0),
      ).toBeNull()
    },
  )

  it.each([1, 2, 3])('%i contra %i: solo un equipo completo avanza', (size) => {
    const a = team('A', size)
    const b = team('B', size)
    expect(decideAbsence([a, b], new Set(ids('B', size)), () => 0)).toEqual({
      winnerIndex: 1,
      kind: 'ONE_TEAM_READY',
      readyCounts: [0, size],
    })
    expect(decideAbsence([a, b], new Set(ids('A', size)), () => 0.99)).toMatchObject({
      winnerIndex: 0,
      kind: 'ONE_TEAM_READY',
    })
  })

  it('si ninguno está completo avanza el que tiene más jugadores listos', () => {
    const a = team('A', 3)
    const b = team('B', 3)
    expect(decideAbsence([a, b], new Set([...ids('A', 1), ...ids('B', 2)]), () => 0)).toEqual({
      winnerIndex: 1,
      kind: 'MORE_PLAYERS_READY',
      readyCounts: [1, 2],
    })
  })

  it('con el mismo número de jugadores listos (incluido 0 a 0) se sortea', () => {
    const a = team('A', 2)
    const b = team('B', 2)
    expect(decideAbsence([a, b], new Set<string>(), () => 0.49)).toMatchObject({
      winnerIndex: 0,
      kind: 'DRAW',
    })
    expect(decideAbsence([a, b], new Set<string>(), () => 0.5)).toMatchObject({
      winnerIndex: 1,
      kind: 'DRAW',
    })
    expect(decideAbsence([a, b], new Set([...ids('A', 1), ...ids('B', 1)]), () => 0.9)).toEqual({
      winnerIndex: 1,
      kind: 'DRAW',
      readyCounts: [1, 1],
    })
  })

  it('un jugador que no pertenece a los equipos no cuenta', () => {
    const a = team('A', 2)
    const b = team('B', 2)
    expect(decideAbsence([a, b], new Set(['intruso', 'otro']), () => 0)).toMatchObject({
      kind: 'DRAW',
      readyCounts: [0, 0],
    })
  })
})
