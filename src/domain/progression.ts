import type { BracketMatch, PublishedBracket } from './bracket'
import type { MatchRead } from './match-read'
import { requireTerminal } from './match-read'
import { sameJson } from './json'
import { requireRule } from './registration'

export interface ConfirmedMatchResult {
  matchId: BracketMatch['id']
  encounterId: string
  roomId: string | null
  resolutionId?: string
  source?: 'COMBAT' | 'TOURNAMENT'
  teamIds: [string, string]
  winnerTeamId: string | null
  loserTeamId: string | null
  result: MatchRead['result']
  confirmedAt: string
}
export interface Champion {
  teamId: string
  teamName: string
  memberIds: string[]
  heroes: { playerId: string; heroId: string }[]
  finalEncounterId: string
  finalRoomId: string | null
  declaredAt: string
}
export interface ProgressMatch extends Omit<BracketMatch, 'status'> {
  status: 'WAITING' | 'READY' | 'FINISHED' | 'RESOLUTION_REQUIRED'
  winnerTeamId: string | null
  loserTeamId: string | null
}
export interface ProgressBracket extends Omit<PublishedBracket, 'matches'> {
  matches: ProgressMatch[]
}
export const projectBracket = (
  bracket: PublishedBracket,
  results: ConfirmedMatchResult[],
): ProgressBracket => ({
  ...structuredClone(bracket),
  matches: bracket.matches.map((m) => {
    const teamIds: BracketMatch['teamIds'] = m.sources.map((source) => {
      if (source.kind === 'SEED')
        return bracket.seeds.find((s) => s.position === source.position)?.teamId ?? null
      const previous = results.find((r) => r.matchId === source.matchId)
      return (source.kind === 'WINNER' ? previous?.winnerTeamId : previous?.loserTeamId) ?? null
    }) as BracketMatch['teamIds']
    const result = results.find((r) => r.encounterId === m.encounterId)
    return {
      ...structuredClone(m),
      teamIds,
      status: result
        ? result.winnerTeamId === null
          ? 'RESOLUTION_REQUIRED'
          : 'FINISHED'
        : teamIds.every((id) => id !== null)
          ? 'READY'
          : 'WAITING',
      winnerTeamId: result?.winnerTeamId ?? null,
      loserTeamId: result?.loserTeamId ?? null,
    }
  }),
})
export const confirmMatch = (
  bracket: PublishedBracket,
  results: ConfirmedMatchResult[],
  e: MatchRead,
  at: string,
): ConfirmedMatchResult => {
  requireTerminal(e)
  const match = projectBracket(bracket, results).matches.find(
    (m) => m.encounterId === e.encounterId,
  )
  requireRule(
    match !== undefined &&
      e.tournamentId === bracket.tournamentId &&
      match.id === e.bracketLabel &&
      match.track === e.track &&
      match.round === e.round &&
      match.teamIds.every((id) => id !== null) &&
      e.teams.length === 2 &&
      new Set(e.teams.map((t) => t.teamLabel)).size === 2 &&
      new Set(e.teams.map((t) => t.teamId)).size === 2 &&
      e.teams.every((t) => match.teamIds.includes(t.teamId)),
    'RESULT_INCOMPATIBLE',
    'El resultado no corresponde a los participantes resueltos de esta justa.',
    409,
  )
  const players = new Set<string>(),
    heroes = new Set<string>()
  for (const team of e.teams) {
    const seed = bracket.seeds.find((s) => s.teamId === team.teamId)
    requireRule(
      seed?.memberIds.length === team.participants.length &&
        team.participants.every(
          (p) =>
            seed.memberIds.includes(p.playerId) &&
            p.heroId.trim().length > 0 &&
            !players.has(p.playerId) &&
            !heroes.has(p.heroId),
        ),
      'RESULT_INCOMPATIBLE',
      'Roster ajeno o incompleto.',
      409,
    )
    for (const p of team.participants) {
      players.add(p.playerId)
      heroes.add(p.heroId)
    }
    requireRule(
      new Set(team.participants.map((p) => p.playerId)).size === seed.memberIds.length &&
        new Set(team.participants.map((p) => p.heroId)).size === seed.memberIds.length,
      'RESULT_INCOMPATIBLE',
      'Roster repetido.',
      409,
    )
  }
  const winner =
    e.result.outcome === 'WIN'
      ? (e.teams.find((t) => t.teamLabel === e.result.winnerTeamLabel)?.teamId ?? null)
      : null
  requireRule(
    e.result.outcome !== 'WIN' || winner !== null,
    'RESULT_INCOMPATIBLE',
    'Ganador ajeno al roster.',
    409,
  )
  const teamIds = match.teamIds as [string, string]
  const confirmed: ConfirmedMatchResult = {
    matchId: match.id,
    encounterId: e.encounterId,
    roomId: e.combatRoomId,
    resolutionId: `combat:${e.combatRoomId}`,
    source: 'COMBAT',
    teamIds: structuredClone(teamIds),
    winnerTeamId: winner,
    loserTeamId: winner === null ? null : teamIds[0] === winner ? teamIds[1] : teamIds[0],
    result: structuredClone(e.result),
    confirmedAt: at,
  }
  const previous = results.find((r) => r.encounterId === e.encounterId)
  if (previous !== undefined) {
    requireRule(
      sameJson({ ...confirmed, confirmedAt: previous.confirmedAt }, previous),
      'RESULT_INCOMPATIBLE',
      'No se puede corregir un resultado confirmado.',
      409,
    )
    return previous
  }
  results.push(confirmed)
  return confirmed
}
export const declareChampion = (
  bracket: PublishedBracket,
  results: ConfirmedMatchResult[],
  e: MatchRead,
  at: string,
): Champion | null => {
  const final = results.find((r) => r.encounterId === e.encounterId && r.matchId === 'Final')
  if (final?.winnerTeamId === undefined || final.winnerTeamId === null) return null
  requireRule(
    bracket.matches.every((m) =>
      results.some((r) => r.encounterId === m.encounterId && r.winnerTeamId !== null),
    ),
    'FINAL_DEPENDENCIES_REQUIRED',
    'Faltan dependencias de la final.',
    409,
  )
  const seed = bracket.seeds.find((s) => s.teamId === final.winnerTeamId)
  const roster = e.teams.find((t) => t.teamId === final.winnerTeamId)
  requireRule(
    seed !== undefined && roster !== undefined,
    'RESULT_INCOMPATIBLE',
    'Falta el roster del campeón.',
    409,
  )
  return {
    teamId: seed.teamId,
    teamName: seed.name,
    memberIds: structuredClone(seed.memberIds),
    heroes: structuredClone([...roster.participants]),
    finalEncounterId: e.encounterId,
    finalRoomId: final.roomId,
    declaredAt: at,
  }
}
