import type { MatchRead } from '../../src/domain/match-read'
import type { PublishedBracket, MatchId } from '../../src/domain/bracket'
import { projectBracket, type ConfirmedMatchResult } from '../../src/domain/progression'
import type { TournamentMatchReadPort } from '../../src/application/ports/TournamentMatchReadPort'
import type { TournamentEncounter } from '../../src/domain/entities/TournamentEncounter'
import type { TournamentMode } from '../../src/domain/registration'
import type { RegistrationRepository } from '../../src/application/ports/RegistrationPorts'
import { fixture, FREE_POLICY } from './registration-fixture'

/** Proveedor controlado. No implementa ni prueba acciones HU-85 o un motor real. */
export class ControlledMatchRead implements TournamentMatchReadPort {
  readonly items = new Map<string, MatchRead>()
  read = jest.fn((id: string, encounterId: string) =>
    Promise.resolve(
      structuredClone(
        [...this.items.values()].find(
          (e) => e.tournamentId === id && e.encounterId === encounterId,
        ) ?? null,
      ),
    ),
  )
  list = jest.fn((id: string) =>
    Promise.resolve(structuredClone([...this.items.values()].filter((e) => e.tournamentId === id))),
  )
}
export const storedFixture = (e: MatchRead, bracket: PublishedBracket): TournamentEncounter => ({
  tournamentId: e.tournamentId,
  encounterId: e.encounterId,
  bracketLabel: e.bracketLabel,
  round: e.round,
  status: e.status,
  teams: e.teams,
  combatRoomId: e.combatRoomId,
  startedAt: e.startedAt === null ? null : new Date(e.startedAt),
  closedAt: e.closedAt === null ? null : new Date(e.closedAt),
  result: e.result === null ? null : { ...e.result, finishedAt: new Date(e.result.finishedAt) },
  lastSyncedSeq: e.lastSyncedSeq,
  logComplete: e.logComplete,
  bracketMetadata: {
    bracketTrack: e.track!,
    registeredTeams: e.teams.map((t) => {
      const seed = bracket.seeds.find((s) => s.teamId === t.teamId)!
      return {
        teamId: seed.teamId,
        name: seed.name,
        avatar: seed.avatar,
        memberIds: seed.memberIds,
      }
    }),
    preparationStatus: e.status === 'FINISHED' ? 'FINISHED' : 'IN_BATTLE',
    engineLastSeq: e.engineLastSeq,
    syncedAt: '2026-10-12T12:10:00.000Z',
  },
})
export const publishedFixture = async (
  repository?: RegistrationRepository,
  mode?: TournamentMode,
) => {
  const f = fixture(repository, FREE_POLICY),
    t = await f.create(mode)
  for (let n = 0; n < 8; n++) {
    if (mode === undefined) {
      await f.confirm(t.id, n)
      continue
    }
    const memberIds = Array.from(
      { length: t.teamSize },
      (_, i) => 'mode-' + String(n) + '-' + String(i),
    )
    const owner = memberIds[0]!
    const team = await f.registrations.register(t.id, owner, {
      operationId: 'register-' + String(n),
      name: 'Equipo ' + String(n),
      invitedMemberIds: memberIds.slice(1),
      avatar: { kind: 'ACCOUNT_AVATAR', subject: owner },
    })
    for (const member of memberIds.slice(1))
      await f.registrations.consent(t.id, team.id, member, 'consent-' + member, true)
    await f.registrations.enter(t.id, team.id, owner, { operationId: 'pay-' + String(n) })
  }
  f.setNow('2026-10-10T00:00:00Z')
  await f.brackets.publish(t.id, 'admin', 'publish')
  return { ...f, tournament: await f.repo.read(t.id), id: t.id }
}
export const matchFixture = (
  bracket: PublishedBracket,
  label: MatchId = 'E1',
  results: ConfirmedMatchResult[] = [],
  winner: string | null = 'A',
  finished = true,
  count = 120,
): MatchRead => {
  const match = projectBracket(bracket, results).matches.find((m) => m.id === label)!
  const teams = match.teamIds.map((teamId, i) => {
    const seed = bracket.seeds.find((s) => s.teamId === teamId)!
    return {
      teamId: seed.teamId,
      teamLabel: i === 0 ? 'A' : 'B',
      participants: seed.memberIds.map((playerId) => ({
        playerId,
        heroId: 'fixture-hero-' + playerId,
      })),
    }
  })
  const result = finished
    ? {
        outcome: winner === null ? 'NO_WINNER' : 'WIN',
        winnerTeamLabel: winner,
        reason: 'ELIMINATION',
        finishedAt: '2026-10-12T12:10:00.000Z',
      }
    : null
  const roomId = 'fixture-room-' + label
  const turnOrder = teams
    .flatMap((team) =>
      team.participants.map((p, seat) => ({
        ...p,
        seat,
        kind: 'HUMAN',
        teamLabel: team.teamLabel,
        displayName: 'Fixture ' + p.playerId,
      })),
    )
    .map((p, position) => ({ ...p, position }))
  const battle = {
    battleId: roomId,
    startedAt: '2026-10-12T12:00:00.000Z',
    round: 2,
    turnsCompleted: 4,
    turnOrder,
    currentTurn: turnOrder[0],
    combatants: turnOrder.map((p) => ({
      teamLabel: p.teamLabel,
      seat: p.seat,
      health: { current: 90, max: 100 },
      power: { current: 80, max: 100 },
      internalSeed: 'must-not-be-exposed',
    })),
    secret: 'must-not-be-exposed',
  }
  return {
    tournamentId: bracket.tournamentId,
    encounterId: match.encounterId,
    bracketLabel: label,
    track: match.track,
    round: match.round,
    status: finished ? 'FINISHED' : 'IN_PROGRESS',
    combatRoomId: roomId,
    teams,
    startedAt: battle.startedAt,
    closedAt: result?.finishedAt ?? null,
    result,
    lastSyncedSeq: count,
    engineLastSeq: count,
    logComplete: true,
    events: Array.from({ length: count }, (_, i) => {
      const seq = i + 1,
        type =
          seq === count && finished
            ? 'battleFinished'
            : seq === 1
              ? 'battleStarted'
              : 'turnAdvanced',
        occurredAt = result?.finishedAt ?? '2026-10-12T12:01:00.000Z'
      return {
        tournamentId: bracket.tournamentId,
        encounterId: match.encounterId,
        seq,
        type,
        occurredAt: new Date(occurredAt),
        payload: {
          roomId,
          seq,
          type,
          occurredAt,
          result,
          battle,
          token: 'must-not-be-exposed',
          commandId: 'private-action',
        },
      }
    }),
  }
}
