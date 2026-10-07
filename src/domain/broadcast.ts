import { archiveValid, terminalValid, type MatchRead } from './match-read'
import { requireRule, type RegistrationTournament } from './registration'

export interface BroadcastState {
  tournamentId: string
  broadcasterId: string | null
  selectedMatchId: string | null
  revision: number
}
export const emptyBroadcast = (tournamentId: string): BroadcastState => ({
  tournamentId,
  broadcasterId: null,
  selectedMatchId: null,
  revision: 0,
})
export interface BroadcastCombatant {
  teamLabel: string
  playerId: string
  heroId: string
  displayName: string | null
  position: number
  seat: number
  heroSubtype: string | null
  health: { current: number; max: number } | null
  power: { current: number; max: number } | null
}
export interface BroadcastSnapshot {
  tournamentId: string
  tournamentName: string
  matchId: string
  encounterId: string
  bracketLabel: string
  combatRoomId: string
  startedAt: string
  track: MatchRead['track']
  round: number
  status: 'IN_PROGRESS' | 'FINISHED'
  seq: number
  observedAt: string
  teams: { teamId: string; teamLabel: string; name: string }[]
  battleRound: number
  turnsCompleted: number
  currentPlayerId: string
  combatants: BroadcastCombatant[]
  lastAction: { type: string; occurredAt: string }
  result: {
    outcome: 'WIN' | 'NO_WINNER'
    winnerTeamLabel: string | null
    reason: string
    finishedAt: string
  } | null
}
const object = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x)
function valid(condition: boolean): asserts condition {
  requireRule(
    condition,
    'OBSERVATION_INVALID',
    'Combat aún no ofrece un estado visible completo de esta justa.',
    503,
  )
}
const counter = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) >= 0
const meter = (raw: unknown, allowZeroMax = false): BroadcastCombatant['health'] => {
  if (raw === null || raw === undefined) return null
  valid(object(raw))
  const r = raw
  valid(
    counter(r.current) && counter(r.max) && r.max >= (allowZeroMax ? 0 : 1) && r.current <= r.max,
  )
  return { current: r.current, max: r.max }
}
const publicResult = (result: MatchRead['result']): BroadcastSnapshot['result'] => {
  if (result === null) return null
  const outcome = result.outcome
  valid(outcome === 'WIN' || outcome === 'NO_WINNER')
  return {
    outcome,
    winnerTeamLabel: result.winnerTeamLabel,
    reason: result.reason,
    finishedAt: result.finishedAt,
  }
}
/** Only publish named visible fields from the latest authoritative BattleEventWire. */
export const broadcastSnapshot = (
  e: MatchRead,
  t: RegistrationTournament,
  at: string,
): BroadcastSnapshot => {
  const teamSize = t.teamSize ?? 2
  const roster = e.teams
  const roomId = e.combatRoomId
  valid(
    (e.status === 'IN_PROGRESS' || e.status === 'FINISHED') &&
      roomId !== null &&
      roster.length === 2 &&
      e.tournamentId === t.id &&
      e.track !== null &&
      archiveValid(e) &&
      e.lastSyncedSeq === e.engineLastSeq,
  )
  valid(e.status !== 'FINISHED' || terminalValid(e))
  valid(e.status === 'FINISHED' || e.result === null)
  valid(e.result === null || e.result.outcome === 'WIN' || e.result.outcome === 'NO_WINNER')
  valid(
    new Set(roster.map((team) => team.teamId)).size === 2 &&
      new Set(roster.map((team) => team.teamLabel)).size === 2,
  )
  for (const team of roster) {
    const seed = t.bracket?.seeds.find((s) => s.teamId === team.teamId)
    valid(
      seed !== undefined &&
        team.participants.length === teamSize &&
        seed.memberIds.length === teamSize &&
        team.participants.every((p) => seed.memberIds.includes(p.playerId)),
    )
    valid(new Set(team.participants.map((p) => p.playerId)).size === teamSize)
  }
  const last = e.events.at(-1)
  valid(last !== undefined)
  valid(last.seq === e.lastSyncedSeq && object(last.payload) && object(last.payload.battle))
  const battle = last.payload.battle
  valid(
    battle.battleId === e.combatRoomId &&
      battle.startedAt === e.startedAt &&
      typeof battle.startedAt === 'string' &&
      !Number.isNaN(Date.parse(battle.startedAt)) &&
      counter(battle.turnsCompleted) &&
      counter(battle.round) &&
      battle.round > 0,
  )
  valid(
    Array.isArray(battle.turnOrder) &&
      battle.turnOrder.length === teamSize * 2 &&
      Array.isArray(battle.combatants) &&
      battle.combatants.length === teamSize * 2 &&
      object(battle.currentTurn),
  )
  const order: unknown[] = battle.turnOrder
  const visible: unknown[] = battle.combatants
  const keys = new Set<string>()
  const players = new Set<string>()
  const combatants = order.map((entry, position): BroadcastCombatant => {
    valid(
      object(entry) &&
        entry.kind === 'HUMAN' &&
        entry.position === position &&
        counter(entry.seat) &&
        entry.seat < teamSize &&
        typeof entry.teamLabel === 'string' &&
        typeof entry.playerId === 'string' &&
        typeof entry.heroId === 'string',
    )
    const team = roster.find((x) => x.teamLabel === entry.teamLabel)
    valid(
      team?.participants.some((p) => p.playerId === entry.playerId && p.heroId === entry.heroId) ===
        true,
    )
    const key = `${entry.teamLabel}:${String(entry.seat)}`
    valid(!keys.has(key) && !players.has(entry.playerId))
    keys.add(key)
    players.add(entry.playerId)
    const c = visible.find(
      (x) => object(x) && x.teamLabel === entry.teamLabel && x.seat === entry.seat,
    )
    valid(object(c) && (entry.displayName === null || typeof entry.displayName === 'string'))
    valid(
      entry.heroSubtype === undefined ||
        entry.heroSubtype === null ||
        typeof entry.heroSubtype === 'string',
    )
    return {
      teamLabel: entry.teamLabel,
      playerId: entry.playerId,
      heroId: entry.heroId,
      displayName: entry.displayName,
      position,
      seat: entry.seat,
      heroSubtype: typeof entry.heroSubtype === 'string' ? entry.heroSubtype : null,
      health: meter(c.health),
      power: meter(c.power, true),
    }
  })
  const current = battle.currentTurn
  valid(
    order.some(
      (x) =>
        object(x) &&
        x.position === current.position &&
        x.playerId === current.playerId &&
        x.teamLabel === current.teamLabel &&
        x.seat === current.seat,
    ),
  )
  return {
    tournamentId: e.tournamentId,
    tournamentName: t.name,
    matchId: e.encounterId,
    encounterId: e.encounterId,
    bracketLabel: e.bracketLabel,
    combatRoomId: roomId,
    startedAt: battle.startedAt,
    track: e.track,
    round: e.round,
    status: e.status,
    seq: e.lastSyncedSeq,
    observedAt: at,
    teams: roster.map((team) => ({
      teamId: team.teamId,
      teamLabel: team.teamLabel,
      name: t.bracket?.seeds.find((s) => s.teamId === team.teamId)?.name ?? team.teamId,
    })),
    battleRound: battle.round,
    turnsCompleted: battle.turnsCompleted,
    currentPlayerId: String(current.playerId),
    combatants,
    lastAction: { type: last.type, occurredAt: last.occurredAt.toISOString() },
    result: publicResult(e.result),
  }
}
