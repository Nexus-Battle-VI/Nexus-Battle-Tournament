import type { BracketMatch } from './bracket'
import type { ConfirmedMatchResult } from './progression'
import type { AcceptedPlayer, RoundWindow, TournamentResolution } from './match-acceptance'
import type { TeamSize, TournamentMode } from './registration'
import { requireRule } from './registration'

export interface AcceptanceReceipt extends AcceptedPlayer {
  acceptanceOpensAt: string
  acceptanceClosesAt: string
  replayed: boolean
}
export const acceptanceReceipt = (
  a: AcceptedPlayer,
  w: RoundWindow,
  replayed: boolean,
): AcceptanceReceipt => ({
  ...a,
  acceptanceOpensAt: w.acceptanceOpensAt,
  acceptanceClosesAt: w.acceptanceClosesAt,
  replayed,
})
export const absenceResolution = (r: TournamentResolution, teamSize: TeamSize) => ({
  resultType: 'ABSENCE' as const,
  resolutionId: r.resolutionId,
  resolvedAt: r.resolvedAt,
  teamIds: r.teamIds,
  winnerTeamId: r.winnerTeamId,
  loserTeamId: r.loserTeamId,
  acceptedCounts: r.acceptedCounts,
  teamSize,
  ruleApplied:
    r.rule === 'COMPLETE_TEAM'
      ? ('ONE_COMPLETE' as const)
      : r.rule === 'MORE_ACCEPTANCES'
        ? ('HIGHER_ACCEPTANCE_COUNT' as const)
        : ('TIED_ACCEPTANCE_COUNT' as const),
  reason: 'ACCEPTANCE_WINDOW_CLOSED' as const,
  tieBreak:
    r.coinBit === null
      ? null
      : { kind: 'UNBIASED_50_50' as const, drawId: r.resolutionId, selectedSide: r.coinBit },
})
export const playedResolution = (r: ConfirmedMatchResult) => {
  requireRule(
    r.roomId !== null && r.result !== null && r.source !== 'TOURNAMENT',
    'OFFICIAL_RESULT_REQUIRED',
    'Falta el resultado validado de Combat.',
    503,
  )
  return {
    resultType: 'PLAYED' as const,
    resolutionId: r.resolutionId ?? `combat:${r.roomId}:terminal`,
    resolvedAt: r.result.finishedAt,
    teamIds: r.teamIds,
    winnerTeamId: r.winnerTeamId,
    loserTeamId: r.loserTeamId,
    combatRoomId: r.roomId,
    combatResult: r.result,
  }
}
export type PublicResolution =
  ReturnType<typeof absenceResolution> | ReturnType<typeof playedResolution>
export interface ConvocationExtension extends RoundWindow {
  contractVersion: 'torneos-v3.0.0'
  tournamentMode: TournamentMode
  teamSize: TeamSize
  serverNow: string
  acceptanceStatus: 'SCHEDULED' | 'OPEN' | 'CLOSED' | 'BLOCKED_DELAY' | 'RESOLVED'
  operationalStatus:
    | 'IDLE'
    | 'RESOLUTION_PENDING'
    | 'PREPARE_PENDING'
    | 'START_PENDING'
    | 'IN_BATTLE'
    | 'FINISHED'
    | 'DEPENDENCY_ERROR'
  acceptedCounts: [number, number]
  myAcceptance: AcceptanceReceipt | null
  blockReason: { code: string; message: string; since: string; responsible: string } | null
  resolution: PublicResolution | null
  winnerTeamId: string | null
  loserTeamId: string | null
  sources?: BracketMatch['sources']
  destinations?: BracketMatch['destinations']
}
