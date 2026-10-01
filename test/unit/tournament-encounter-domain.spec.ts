import {
  applyCombatProjection,
  TournamentMatchStatus,
  type TournamentEncounter,
} from '../../src/domain/entities/TournamentEncounter'

const baseEncounter: TournamentEncounter = {
  tournamentId: 'T1',
  encounterId: 'E2',
  round: 1,
  bracketLabel: 'E2',
  teams: [
    { teamId: 'equipo-a', teamLabel: 'A', participants: [{ playerId: 'p1', heroId: 'h1' }] },
    { teamId: 'equipo-b', teamLabel: 'B', participants: [{ playerId: 'p2', heroId: 'h2' }] },
  ],
  status: TournamentMatchStatus.Ready,
  combatRoomId: 'room-T1-E2',
  startedAt: null,
  closedAt: null,
  result: null,
  lastSyncedSeq: 0,
  logComplete: false,
}

describe('applyCombatProjection', () => {
  it('pasa a EN CURSO cuando Combat informa la sala en batalla (CA-02)', () => {
    const projected = applyCombatProjection(baseEncounter, {
      status: 'IN_BATTLE',
      startedAt: new Date('2026-09-30T20:00:00.000Z'),
      result: null,
      lastSeq: 2,
      logComplete: false,
    })

    expect(projected.status).toBe(TournamentMatchStatus.InProgress)
    expect(projected.startedAt).toEqual(new Date('2026-09-30T20:00:00.000Z'))
    expect(projected.lastSyncedSeq).toBe(2)
  })

  /**
   * CA-04: un encuentro en curso nunca muestra ganador ni fecha de cierre
   * inventados.
   */
  it('no inventa ganador ni cierre mientras la sala esta en curso', () => {
    const projected = applyCombatProjection(baseEncounter, {
      status: 'IN_BATTLE',
      startedAt: new Date('2026-09-30T20:00:00.000Z'),
      result: null,
      lastSeq: 2,
      logComplete: false,
    })

    expect(projected.result).toBeNull()
    expect(projected.closedAt).toBeNull()
  })

  /**
   * Defensa adicional: si Combat dijera "FINISHED" pero sin resultado
   * adjunto (dato incoherente), el encuentro NO pasa a finalizado solo por
   * el estado. Nunca se inventa un resultado.
   */
  it('no finaliza una justa sin un resultado autoritativo que lo acompane', () => {
    const projected = applyCombatProjection(baseEncounter, {
      status: 'FINISHED',
      startedAt: new Date('2026-09-30T20:00:00.000Z'),
      result: null,
      lastSeq: 3,
      logComplete: true,
    })

    expect(projected.status).not.toBe(TournamentMatchStatus.Finished)
    expect(projected.result).toBeNull()
    expect(projected.closedAt).toBeNull()
  })

  it('finaliza con el resultado autoritativo de Combat y fija el cierre', () => {
    const finishedAt = new Date('2026-09-30T20:18:00.000Z')
    const projected = applyCombatProjection(baseEncounter, {
      status: 'FINISHED',
      startedAt: new Date('2026-09-30T20:00:00.000Z'),
      result: { winnerTeamLabel: 'A', reason: 'OPPONENT_DEFEATED', outcome: 'VICTORY', finishedAt },
      lastSeq: 5,
      logComplete: true,
    })

    expect(projected.status).toBe(TournamentMatchStatus.Finished)
    expect(projected.result).toEqual({
      winnerTeamLabel: 'A',
      reason: 'OPPONENT_DEFEATED',
      outcome: 'VICTORY',
      finishedAt,
    })
    expect(projected.closedAt).toEqual(finishedAt)
  })

  it('NO_WINNER se conserva tal cual, sin ganador inventado', () => {
    const finishedAt = new Date('2026-09-30T20:30:00.000Z')
    const projected = applyCombatProjection(baseEncounter, {
      status: 'FINISHED',
      startedAt: new Date('2026-09-30T20:00:00.000Z'),
      result: {
        winnerTeamLabel: null,
        reason: 'DOUBLE_DISCONNECT',
        outcome: 'NO_WINNER',
        finishedAt,
      },
      lastSeq: 4,
      logComplete: true,
    })

    expect(projected.status).toBe(TournamentMatchStatus.Finished)
    expect(projected.result?.winnerTeamLabel).toBeNull()
  })

  /**
   * CA-03: reenviar el cierre (u otro evento) de una justa ya finalizada no
   * cambia ni duplica el resultado ya fijado.
   */
  it('una justa FINISHED es terminal: reenviar el cierre no cambia el resultado', () => {
    const finishedAt = new Date('2026-09-30T20:18:00.000Z')
    const finished: TournamentEncounter = {
      ...baseEncounter,
      status: TournamentMatchStatus.Finished,
      closedAt: finishedAt,
      result: { winnerTeamLabel: 'A', reason: 'OPPONENT_DEFEATED', outcome: 'VICTORY', finishedAt },
      lastSyncedSeq: 5,
      logComplete: true,
    }

    // Se reenvia el MISMO evento de cierre, y tambien se intenta uno distinto
    // con otro ganador: en ningun caso cambia el resultado ya fijado.
    const repeated = applyCombatProjection(finished, {
      status: 'FINISHED',
      startedAt: finished.startedAt,
      result: finished.result,
      lastSeq: 5,
      logComplete: true,
    })
    const tampered = applyCombatProjection(finished, {
      status: 'FINISHED',
      startedAt: finished.startedAt,
      result: { winnerTeamLabel: 'B', reason: 'OTHER', outcome: 'VICTORY', finishedAt },
      lastSeq: 6,
      logComplete: true,
    })

    expect(repeated.result).toEqual(finished.result)
    expect(repeated.closedAt).toEqual(finished.closedAt)
    expect(tampered.result).toEqual(finished.result)
    expect(tampered.closedAt).toEqual(finished.closedAt)
  })

  it('el "lastSyncedSeq" solo avanza, nunca retrocede', () => {
    const encounter: TournamentEncounter = { ...baseEncounter, lastSyncedSeq: 5 }
    const projected = applyCombatProjection(encounter, {
      status: 'IN_BATTLE',
      startedAt: null,
      result: null,
      lastSeq: 2,
      logComplete: false,
    })

    expect(projected.lastSyncedSeq).toBe(5)
  })

  it('el "startedAt" se fija una vez y no se reescribe en lecturas posteriores', () => {
    const originalStart = new Date('2026-09-30T20:00:00.000Z')
    const encounter: TournamentEncounter = { ...baseEncounter, startedAt: originalStart }
    const projected = applyCombatProjection(encounter, {
      status: 'IN_BATTLE',
      startedAt: new Date('2026-09-30T20:05:00.000Z'),
      result: null,
      lastSeq: 3,
      logComplete: false,
    })

    expect(projected.startedAt).toEqual(originalStart)
  })

  it('una justa FINISHED puede seguir acumulando "logComplete" para eventos sobrantes', () => {
    const finished: TournamentEncounter = {
      ...baseEncounter,
      status: TournamentMatchStatus.Finished,
      lastSyncedSeq: 4,
      logComplete: false,
      closedAt: new Date('2026-09-30T20:18:00.000Z'),
      result: {
        winnerTeamLabel: 'A',
        reason: 'OPPONENT_DEFEATED',
        outcome: 'VICTORY',
        finishedAt: new Date('2026-09-30T20:18:00.000Z'),
      },
    }

    const projected = applyCombatProjection(finished, {
      status: 'FINISHED',
      startedAt: finished.startedAt,
      result: finished.result,
      lastSeq: 5,
      logComplete: true,
    })

    expect(projected.lastSyncedSeq).toBe(5)
    expect(projected.logComplete).toBe(true)
  })
})
