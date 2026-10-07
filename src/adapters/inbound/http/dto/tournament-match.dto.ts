import { IsInt, IsOptional, Min } from 'class-validator'
import { Type } from 'class-transformer'
import { ApiPropertyOptional } from '@nestjs/swagger'
import type { ConvocationExtension } from '../../../../domain/convocation'

import type { CombatEventPage } from '../../../../domain/entities/CombatEventRecord'
import type {
  TournamentEncounter,
  EncounterBracketMetadata,
  TournamentEncounterTeam,
  TournamentMatchResult,
} from '../../../../domain/entities/TournamentEncounter'

/** Query de `GET /matches/:matchId`. `afterSeq` por defecto 0: desde el principio. */
export class MatchDetailQueryDto {
  @ApiPropertyOptional({
    description: 'Leer eventos a partir de esta secuencia (exclusive). 0 = desde el principio.',
    default: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  afterSeq?: number
}

export interface TeamResponse {
  readonly teamId: string
  readonly teamLabel: string
  readonly participants: readonly { playerId: string; heroId: string }[]
}

export interface MatchResultResponse {
  readonly winnerTeamLabel: string | null
  readonly reason: string
  readonly outcome: string
  readonly finishedAt: string
}

export interface MatchSummaryResponse extends Partial<Omit<ConvocationExtension, 'round'>> {
  readonly encounterId?: string
  readonly bracketTrack?: EncounterBracketMetadata['bracketTrack']
  readonly registeredTeams?: EncounterBracketMetadata['registeredTeams']
  readonly preparationStatus?: string
  readonly combatRoomId?: string | null
  readonly lastSyncedSeq?: number
  readonly engineLastSeq?: number | null
  readonly syncedAt?: string | null
  readonly tournamentId: string
  readonly matchId: string
  readonly round: number
  readonly bracketLabel: string
  readonly status: string
  readonly startedAt: string | null
  readonly closedAt: string | null
}

export interface MatchDetailResponse extends MatchSummaryResponse {
  readonly teams: readonly TeamResponse[]
  readonly result: MatchResultResponse | null
  readonly events: readonly {
    readonly seq: number
    readonly type: string
    readonly occurredAt: string
    readonly payload: unknown
  }[]
  readonly afterSeq: number
  readonly nextSeq: number
  readonly hasMore: boolean
  readonly logComplete: boolean
}

const toTeamResponse = (team: TournamentEncounterTeam): TeamResponse => ({
  teamId: team.teamId,
  teamLabel: team.teamLabel,
  participants: team.participants.map((p) => ({ playerId: p.playerId, heroId: p.heroId })),
})

const toResultResponse = (result: TournamentMatchResult | null): MatchResultResponse | null =>
  result === null
    ? null
    : {
        winnerTeamLabel: result.winnerTeamLabel,
        reason: result.reason,
        outcome: result.outcome,
        finishedAt: result.finishedAt.toISOString(),
      }

export const toMatchSummaryResponse = (encounter: TournamentEncounter): MatchSummaryResponse => ({
  ...(encounter.bracketMetadata === undefined
    ? {}
    : {
        ...encounter.bracketMetadata,
        encounterId: encounter.encounterId,
        combatRoomId: encounter.combatRoomId,
        lastSyncedSeq: encounter.lastSyncedSeq,
      }),
  tournamentId: encounter.tournamentId,
  matchId: encounter.encounterId,
  round: encounter.round,
  bracketLabel: encounter.bracketLabel,
  status: encounter.status,
  startedAt: encounter.startedAt?.toISOString() ?? null,
  closedAt: encounter.closedAt?.toISOString() ?? null,
})

export const toMatchDetailResponse = (
  encounter: TournamentEncounter,
  page: CombatEventPage,
  afterSeq: number,
): MatchDetailResponse => ({
  ...toMatchSummaryResponse(encounter),
  teams: encounter.teams.map(toTeamResponse),
  result: toResultResponse(encounter.result),
  events: page.events.map((event) => ({
    seq: event.seq,
    type: event.type,
    occurredAt: event.occurredAt.toISOString(),
    payload: event.payload,
  })),
  afterSeq,
  nextSeq: page.nextSeq,
  hasMore: page.hasMore,
  logComplete: encounter.logComplete,
})
