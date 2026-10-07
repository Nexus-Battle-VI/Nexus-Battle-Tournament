import type { TournamentEncounter } from './entities/TournamentEncounter'
import { DomainError } from './errors/DomainError'
/** Una proyección tardía no puede revertir un cierre ni un cursor ya archivados. */
export const mergeArchivedEncounter = (
  current: TournamentEncounter | null,
  incoming: TournamentEncounter,
): TournamentEncounter => {
  if (current === null) return incoming
  if (
    current.tournamentId !== incoming.tournamentId ||
    current.encounterId !== incoming.encounterId ||
    current.round !== incoming.round ||
    current.bracketLabel !== incoming.bracketLabel ||
    (current.combatRoomId !== null &&
      incoming.combatRoomId !== null &&
      current.combatRoomId !== incoming.combatRoomId)
  )
    throw new DomainError('La proyección intenta cambiar la identidad archivada.')
  const terminal = current.status === 'FINISHED'
  const status = terminal
    ? 'FINISHED'
    : current.status === 'IN_PROGRESS' &&
        ['READY', 'WAITING_PARTICIPANTS'].includes(incoming.status)
      ? 'IN_PROGRESS'
      : current.status === 'READY' && incoming.status === 'WAITING_PARTICIPANTS'
        ? 'READY'
        : incoming.status
  const metadata =
    incoming.lastSyncedSeq >= current.lastSyncedSeq
      ? (incoming.bracketMetadata ?? current.bracketMetadata)
      : (current.bracketMetadata ?? incoming.bracketMetadata)
  return {
    ...incoming,
    status,
    teams: current.teams.length > 0 ? current.teams : incoming.teams,
    combatRoomId: current.combatRoomId ?? incoming.combatRoomId,
    startedAt: current.startedAt ?? incoming.startedAt,
    result: terminal ? current.result : incoming.result,
    closedAt: terminal ? current.closedAt : incoming.closedAt,
    lastSyncedSeq: Math.max(current.lastSyncedSeq, incoming.lastSyncedSeq),
    logComplete:
      incoming.lastSyncedSeq >= current.lastSyncedSeq ? incoming.logComplete : current.logComplete,
    ...(metadata === undefined
      ? {}
      : {
          bracketMetadata: {
            ...metadata,
            registeredTeams: current.bracketMetadata?.registeredTeams.every((team) => team !== null)
              ? current.bracketMetadata.registeredTeams
              : metadata.registeredTeams,
            preparationStatus:
              status === 'FINISHED'
                ? 'FINISHED'
                : status === 'IN_PROGRESS'
                  ? 'IN_BATTLE'
                  : metadata.preparationStatus,
          },
        }),
  }
}
