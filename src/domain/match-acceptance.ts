import { requireRule } from './registration'
import type { TournamentMode, TeamSize } from './registration'
export const ACCEPTANCE_POLICY = 'ROUND_ACCEPTANCE_V1' as const
export interface RoundWindow {
  round: number
  acceptanceOpensAt: string
  acceptanceClosesAt: string
  scheduledStartAt: string
}
export const roundWindows = (startsAt: string): RoundWindow[] =>
  Array.from({ length: 6 }, (_, i) => {
    const open = new Date(startsAt).getTime() + i * 10 * 60_000
    return {
      round: i + 1,
      acceptanceOpensAt: new Date(open).toISOString(),
      acceptanceClosesAt: new Date(open + 120_000).toISOString(),
      scheduledStartAt: new Date(open + 120_000).toISOString(),
    }
  })
export interface AcceptedPlayer {
  receiptId: string
  tournamentId: string
  encounterId: string
  teamId: string
  subject: string
  operationId: string
  acceptedAt: string
}
export interface PendingAcceptance {
  requestId: string
  subject: string
  operationId: string
  requestedAt: string
}
export interface ResolvedTeam {
  teamId: string
  memberIds: string[]
}
export interface TournamentResolution {
  resolutionId: string
  tournamentId: string
  encounterId: string
  teamIds: [string, string]
  winnerTeamId: string
  loserTeamId: string
  reason: 'ABSENCE_OPPONENT_INCOMPLETE' | 'ABSENCE_MORE_ACCEPTANCES' | 'ABSENCE_TIED_ACCEPTANCES'
  rule: 'COMPLETE_TEAM' | 'MORE_ACCEPTANCES' | 'FAIR_COIN'
  ruleVersion: typeof ACCEPTANCE_POLICY
  acceptedCounts: [number, number]
  coinBit: 0 | 1 | null
  resolvedAt: string
  combatRoomId: null
}
export interface OperationalBlocker {
  code: string
  message: string
  since: string
  responsible: 'TOURNAMENT_OPERATIONS' | 'COMBAT_OPERATIONS' | 'PRIZE_OPERATIONS'
}
export interface CombatIntent {
  prepareOperationId: string
  startOperationId: string
  phase: 'PREPARE_PENDING' | 'START_PENDING' | 'STARTED'
  roomId: string | null
  attempts: number
  leaseToken: string | null
  leaseUntil: string | null
}
export interface MatchAcceptanceState {
  tournamentId: string
  encounterId: string
  tournamentMode: TournamentMode
  teamSize: TeamSize
  window: RoundWindow
  phase: 'SCHEDULED' | 'OPEN' | 'BLOCKED' | 'CLOSED'
  openedAt: string | null
  lastObservedAt: string | null
  decidedAt: string | null
  roster: [ResolvedTeam, ResolvedTeam] | null
  acceptances: AcceptedPlayer[]
  pendingAcceptances: PendingAcceptance[]
  operations: Record<string, { subject: string; receiptId: string }>
  decision: 'COMBAT' | 'TOURNAMENT' | null
  resolution: TournamentResolution | null
  combatIntent: CombatIntent | null
  blocker: OperationalBlocker | null
}
export const acceptanceCounts = (s: MatchAcceptanceState): [number, number] =>
  (s.roster?.map((team) => s.acceptances.filter((a) => a.teamId === team.teamId).length) as
    [number, number] | undefined) ?? [0, 0]
/** Decisión pura salvo el bit inyectado. Invocar únicamente dentro del cierre transaccional. */
export const closeAcceptance = (
  s: MatchAcceptanceState,
  now: Date,
  resolutionId: string,
  fairBit: () => 0 | 1,
): void => {
  if (s.decision !== null || s.phase !== 'OPEN') return
  requireRule(
    now.getTime() >= new Date(s.window.acceptanceClosesAt).getTime(),
    'ACCEPTANCE_STILL_OPEN',
    'Todavía no cerró la aceptación.',
    409,
  )
  requireRule(s.roster !== null, 'PARTICIPANTS_UNRESOLVED', 'Faltan equipos resueltos.', 409)
  const counts = acceptanceCounts(s)
  const unresolved = s.pendingAcceptances.find(
    (request) => !s.acceptances.some((a) => a.subject === request.subject),
  )
  if (unresolved !== undefined) {
    s.phase = 'BLOCKED'
    s.blocker = {
      code: 'ACCEPTANCE_SERVICE_INTERRUPTED',
      message:
        'Un intento autorizado de aceptación quedó sin confirmar al cierre. Requiere revisión operativa, sin inferir ausencia.',
      since: unresolved.requestedAt,
      responsible: 'TOURNAMENT_OPERATIONS',
    }
    return
  }
  s.phase = 'CLOSED'
  s.decidedAt = now.toISOString()
  if (counts.every((c) => c === s.teamSize)) {
    s.decision = 'COMBAT'
    s.combatIntent = {
      prepareOperationId: `tournament:${s.encounterId}:prepare`,
      startOperationId: `tournament:${s.encounterId}:start`,
      phase: 'PREPARE_PENDING',
      roomId: null,
      attempts: 0,
      leaseToken: null,
      leaseUntil: null,
    }
    return
  }
  const full = counts.findIndex((c) => c === s.teamSize)
  const bit = full === -1 && counts[0] === counts[1] ? fairBit() : null
  const side =
    full !== -1 ? full : counts[0] === counts[1] ? (bit ?? 0) : counts[0] > counts[1] ? 0 : 1
  const winner = s.roster[side],
    loser = s.roster[side === 0 ? 1 : 0]
  requireRule(winner !== undefined, 'PARTICIPANTS_UNRESOLVED', 'Faltan equipos.', 409)
  s.decision = 'TOURNAMENT'
  s.resolution = {
    resolutionId,
    tournamentId: s.tournamentId,
    encounterId: s.encounterId,
    teamIds: [s.roster[0].teamId, s.roster[1].teamId],
    winnerTeamId: winner.teamId,
    loserTeamId: loser.teamId,
    reason:
      full !== -1
        ? 'ABSENCE_OPPONENT_INCOMPLETE'
        : bit !== null
          ? 'ABSENCE_TIED_ACCEPTANCES'
          : 'ABSENCE_MORE_ACCEPTANCES',
    rule: full !== -1 ? 'COMPLETE_TEAM' : bit !== null ? 'FAIR_COIN' : 'MORE_ACCEPTANCES',
    ruleVersion: ACCEPTANCE_POLICY,
    acceptedCounts: counts,
    coinBit: bit,
    resolvedAt: now.toISOString(),
    combatRoomId: null,
  }
}
