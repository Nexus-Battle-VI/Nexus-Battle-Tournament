/**
 * Regla de ausencia de una justa (decisión comunicada por Carlos, pendiente de
 * reflejarse en la HU #470):
 *
 * - La justa tiene una hora programada. Desde esa hora cada equipo dispone de
 *   dos minutos para aceptar el combate; un equipo está listo solo cuando
 *   aceptan TODOS sus integrantes.
 * - Si solo un equipo está listo, avanza ese. Si ninguno está listo, avanza el
 *   que tenga más jugadores listos y, si empatan (incluido 0 a 0), se sortea.
 * - Si ambos están listos no hay avance por ausencia: se juega el combate.
 * - El avance por ausencia cuenta como una victoria normal, pero se registra
 *   aparte (`reason: 'ABSENCE'`) porque la batalla nunca ocurrió.
 */
export const ACCEPTANCE_WINDOW_MS = 2 * 60 * 1000

export type AbsenceKind = 'ONE_TEAM_READY' | 'MORE_PLAYERS_READY' | 'DRAW'

export interface AbsenceTeam {
  readonly teamId: string
  readonly memberIds: readonly string[]
}

export interface AbsenceDecision {
  readonly winnerIndex: 0 | 1
  readonly kind: AbsenceKind
  readonly readyCounts: readonly [number, number]
}

export interface ReadinessRecord {
  readonly tournamentId: string
  readonly encounterId: string
  readonly playerId: string
  readonly acceptedAt: Date
}

/** Resolución durable del avance por ausencia de una justa. */
export interface AbsenceResolution {
  readonly tournamentId: string
  readonly encounterId: string
  readonly winnerTeamId: string
  readonly kind: AbsenceKind
  readonly readyCounts: readonly [number, number]
  readonly resolvedAt: Date
}

export const acceptanceDeadline = (scheduledAt: Date): Date =>
  new Date(scheduledAt.getTime() + ACCEPTANCE_WINDOW_MS)

/**
 * Decide el avance por ausencia, o `null` cuando ambos equipos están listos.
 * `random` es una fuente en [0,1) inyectable para poder probar el sorteo.
 */
export const decideAbsence = (
  teams: readonly [AbsenceTeam, AbsenceTeam],
  ready: ReadonlySet<string>,
  random: () => number,
): AbsenceDecision | null => {
  const counts = teams.map((team) => team.memberIds.filter((id) => ready.has(id)).length) as [
    number,
    number,
  ]
  const full = teams.map((team, index) => counts[index] === team.memberIds.length)
  if (full[0] === true && full[1] === true) return null
  if (full[0] === true) return { winnerIndex: 0, kind: 'ONE_TEAM_READY', readyCounts: counts }
  if (full[1] === true) return { winnerIndex: 1, kind: 'ONE_TEAM_READY', readyCounts: counts }
  if (counts[0] !== counts[1])
    return {
      winnerIndex: counts[0] > counts[1] ? 0 : 1,
      kind: 'MORE_PLAYERS_READY',
      readyCounts: counts,
    }
  return { winnerIndex: random() < 0.5 ? 0 : 1, kind: 'DRAW', readyCounts: counts }
}
