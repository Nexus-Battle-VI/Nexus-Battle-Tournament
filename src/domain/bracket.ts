import { randomUUID } from 'node:crypto'
import type { RoundWindow, ACCEPTANCE_POLICY } from './match-acceptance'
import {
  CONTRACT_VERSION,
  requireRule,
  teamMemberIds,
  teamConsented,
  MODALITIES_CONTRACT_VERSION,
  type TournamentMode,
  type TeamSize,
  type TeamAvatar,
  type RegistrationTournament,
} from './registration'
import type { TournamentEncounter } from './entities/TournamentEncounter'

export type MatchId = `E${number}` | 'Final'
export type MatchSource =
  { kind: 'SEED'; position: number } | { kind: 'WINNER' | 'LOSER'; matchId: MatchId }
export interface BracketSeed {
  position: number
  teamId: string
  name: string
  avatar: TeamAvatar
  memberIds: string[]
}
interface Destination {
  matchId: MatchId
  side: number
}
export interface BracketMatch {
  id: MatchId
  encounterId: string
  track: 'MAIN' | 'SECONDARY' | 'FINAL'
  round: number
  sources: [MatchSource, MatchSource]
  teamIds: [string | null, string | null]
  status: 'TEAMS_RESOLVED' | 'WAITING'
  destinations: { winner: Destination | null; loser: Destination | null }
}
export interface PublishedBracket {
  acceptancePolicy?: typeof ACCEPTANCE_POLICY | null
  roundSchedule?: RoundWindow[]
  version: 2 | 3
  tournamentMode?: TournamentMode
  teamSize?: TeamSize
  contractVersion: string
  tournamentId: string
  operationId: string
  publishedAt: string
  publishedBy: string
  startsAt: string
  seeds: BracketSeed[]
  matches: BracketMatch[]
}
const seed = (position: number): MatchSource => ({ kind: 'SEED', position })
const winner = (matchId: MatchId): MatchSource => ({ kind: 'WINNER', matchId })
const loser = (matchId: MatchId): MatchSource => ({ kind: 'LOSER', matchId })
// Figure 2, §7.9. One final; E9/E10 cross the losers of E6/E5.
export const BRACKET_DEFINITION: readonly Pick<
  BracketMatch,
  'id' | 'track' | 'round' | 'sources'
>[] = [
  { id: 'E1', track: 'MAIN', round: 1, sources: [seed(1), seed(2)] },
  { id: 'E2', track: 'MAIN', round: 1, sources: [seed(3), seed(4)] },
  { id: 'E3', track: 'MAIN', round: 1, sources: [seed(5), seed(6)] },
  { id: 'E4', track: 'MAIN', round: 1, sources: [seed(7), seed(8)] },
  { id: 'E5', track: 'MAIN', round: 2, sources: [winner('E1'), winner('E2')] },
  { id: 'E6', track: 'MAIN', round: 2, sources: [winner('E3'), winner('E4')] },
  { id: 'E7', track: 'SECONDARY', round: 2, sources: [loser('E1'), loser('E2')] },
  { id: 'E8', track: 'SECONDARY', round: 2, sources: [loser('E3'), loser('E4')] },
  { id: 'E9', track: 'SECONDARY', round: 3, sources: [loser('E6'), winner('E7')] },
  { id: 'E10', track: 'SECONDARY', round: 3, sources: [loser('E5'), winner('E8')] },
  { id: 'E11', track: 'MAIN', round: 3, sources: [winner('E5'), winner('E6')] },
  { id: 'E12', track: 'SECONDARY', round: 4, sources: [winner('E9'), winner('E10')] },
  { id: 'E13', track: 'SECONDARY', round: 5, sources: [loser('E11'), winner('E12')] },
  { id: 'Final', track: 'FINAL', round: 6, sources: [winner('E11'), winner('E13')] },
]

export const generateBracket = (
  t: RegistrationTournament,
  operationId: string,
  subject: string,
  now: Date,
): PublishedBracket => {
  const teams = t.teams
    .filter((team) => team.status === 'CONFIRMED')
    .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
  requireRule(
    teams.length === 8,
    'INSUFFICIENT_CONFIRMED_TEAMS',
    'Se necesitan ocho equipos humanos confirmados para publicar las llaves.',
    409,
  )
  requireRule(
    teams.every(
      (team, i) =>
        team.slot === i + 1 &&
        team.ownerId.trim() !== '' &&
        teamConsented(team, t.teamSize ?? 2) &&
        team.entryReceipt !== null,
    ) &&
      new Set(teams.map((team) => team.id)).size === 8 &&
      new Set(teams.flatMap(teamMemberIds)).size === 8 * (t.teamSize ?? 2),
    'INVALID_BRACKET_ROSTER',
    'Los ocho cupos deben tener el tamaño configurado y personas distintas.',
    409,
  )
  const seeds: BracketSeed[] = teams.map((team, i) => ({
    position: i + 1,
    teamId: team.id,
    name: team.name,
    avatar: team.avatar,
    memberIds: teamMemberIds(team),
  }))
  const matches: BracketMatch[] = BRACKET_DEFINITION.map((definition) => {
    const resolve = (source: MatchSource): string | null =>
      source.kind === 'SEED' ? (seeds[source.position - 1]?.teamId ?? null) : null
    const teamIds: BracketMatch['teamIds'] = [
      resolve(definition.sources[0]),
      resolve(definition.sources[1]),
    ]
    return {
      ...structuredClone(definition),
      encounterId:
        t.contractVersion === MODALITIES_CONTRACT_VERSION
          ? randomUUID()
          : `${t.id}:${definition.id}`,
      teamIds,
      status: teamIds.every((id) => id !== null) ? 'TEAMS_RESOLVED' : 'WAITING',
      destinations: { winner: null, loser: null },
    }
  })
  for (const match of matches)
    for (const [side, source] of match.sources.entries()) {
      if (source.kind === 'SEED') continue
      const origin = matches.find((m) => m.id === source.matchId)
      if (origin)
        origin.destinations[source.kind === 'WINNER' ? 'winner' : 'loser'] = {
          matchId: match.id,
          side,
        }
    }
  return {
    ...(t.acceptancePolicy === undefined || t.acceptancePolicy === null
      ? {}
      : { acceptancePolicy: t.acceptancePolicy, roundSchedule: t.roundWindows }),
    version: t.contractVersion === MODALITIES_CONTRACT_VERSION ? 3 : 2,
    contractVersion: t.contractVersion ?? CONTRACT_VERSION,
    ...(t.contractVersion === MODALITIES_CONTRACT_VERSION
      ? { tournamentMode: t.tournamentMode ?? 'DUO', teamSize: t.teamSize ?? 2 }
      : {}),
    tournamentId: t.id,
    operationId,
    publishedAt: now.toISOString(),
    publishedBy: subject,
    startsAt: t.startsAt,
    seeds,
    matches,
  }
}
/** Identidades del snapshot; equipos conocidos nunca equivalen a héroes preparados. */
export const bracketEncounters = (bracket: PublishedBracket): TournamentEncounter[] =>
  bracket.matches.map((match) => ({
    tournamentId: bracket.tournamentId,
    encounterId: match.encounterId,
    round: match.round,
    bracketLabel: match.id,
    teams: [],
    status: 'WAITING_PARTICIPANTS',
    combatRoomId: null,
    startedAt: null,
    closedAt: null,
    result: null,
    lastSyncedSeq: 0,
    logComplete: false,
    bracketMetadata: {
      ...(bracket.acceptancePolicy === undefined || bracket.acceptancePolicy === null
        ? {}
        : { acceptancePolicy: bracket.acceptancePolicy }),
      ...(bracket.version === 3
        ? { tournamentMode: bracket.tournamentMode, teamSize: bracket.teamSize }
        : {}),
      bracketTrack: match.track,
      registeredTeams: match.teamIds.map((teamId) => {
        const team = bracket.seeds.find((seed) => seed.teamId === teamId)
        return team === undefined
          ? null
          : { teamId: team.teamId, name: team.name, avatar: team.avatar, memberIds: team.memberIds }
      }),
      preparationStatus: match.status === 'TEAMS_RESOLVED' ? 'TEAMS_RESOLVED' : 'WAITING_TEAMS',
      engineLastSeq: null,
      syncedAt: null,
    },
  }))
