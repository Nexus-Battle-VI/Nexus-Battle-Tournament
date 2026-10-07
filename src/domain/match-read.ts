import type { CombatEventRecord } from './entities/CombatEventRecord'
import type { TournamentEncounter } from './entities/TournamentEncounter'
import type { BracketMatch } from './bracket'
import { record, requireRule } from './registration'

/** Lectura del archivo HU-83. No contiene acciones de preparación/inicio HU-85. */
export interface MatchRead {
  tournamentId: string
  encounterId: string
  bracketLabel: string
  track: BracketMatch['track'] | null
  round: number
  status: TournamentEncounter['status']
  combatRoomId: string | null
  teams: TournamentEncounter['teams']
  startedAt: string | null
  closedAt: string | null
  result: {
    outcome: string
    winnerTeamLabel: string | null
    reason: string
    finishedAt: string
  } | null
  lastSyncedSeq: number
  engineLastSeq: number | null
  logComplete: boolean
  events: readonly CombatEventRecord[]
}

export const archiveValid = (e: MatchRead): boolean =>
  e.combatRoomId !== null &&
  Number.isSafeInteger(e.lastSyncedSeq) &&
  e.lastSyncedSeq > 0 &&
  e.logComplete &&
  e.engineLastSeq === e.lastSyncedSeq &&
  e.events.length === e.lastSyncedSeq &&
  e.events.every(
    (event, i) =>
      event.tournamentId === e.tournamentId &&
      event.encounterId === e.encounterId &&
      event.seq === i + 1 &&
      record(event.payload) &&
      event.payload.seq === event.seq &&
      event.payload.type === event.type &&
      event.payload.roomId === e.combatRoomId &&
      typeof event.payload.occurredAt === 'string' &&
      new Date(event.payload.occurredAt).getTime() === event.occurredAt.getTime(),
  )

export const terminalValid = (e: MatchRead): boolean => {
  const terminal = e.events.at(-1)
  if (
    !archiveValid(e) ||
    e.status !== 'FINISHED' ||
    e.result === null ||
    e.startedAt === null ||
    e.closedAt !== e.result.finishedAt ||
    terminal?.type !== 'battleFinished' ||
    !record(terminal.payload) ||
    !record(terminal.payload.result)
  )
    return false
  const result = terminal.payload.result
  return (
    result.outcome === e.result.outcome &&
    result.reason === e.result.reason &&
    result.winnerTeamLabel === e.result.winnerTeamLabel &&
    typeof result.finishedAt === 'string' &&
    new Date(result.finishedAt).getTime() === new Date(e.result.finishedAt).getTime() &&
    terminal.occurredAt.getTime() === new Date(e.result.finishedAt).getTime() &&
    new Date(e.startedAt).getTime() <= new Date(e.result.finishedAt).getTime() &&
    ['ELIMINATION', 'DISCONNECTION', 'TIME_LIMIT'].includes(e.result.reason) &&
    (e.result.outcome === 'WIN'
      ? e.teams.some((t) => t.teamLabel === e.result?.winnerTeamLabel)
      : e.result.outcome === 'NO_WINNER' && e.result.winnerTeamLabel === null)
  )
}

export function requireTerminal(e: MatchRead): asserts e is MatchRead & {
  result: NonNullable<MatchRead['result']>
  combatRoomId: string
} {
  requireRule(
    terminalValid(e),
    'RESULT_INCOMPATIBLE',
    'Falta un archivo terminal completo y coherente de la sala vinculada.',
    409,
  )
}
