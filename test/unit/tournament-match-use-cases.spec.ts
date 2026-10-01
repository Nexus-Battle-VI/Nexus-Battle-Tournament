import {
  TournamentMatchStatus,
  type TournamentEncounter,
} from '../../src/domain/entities/TournamentEncounter'
import { TournamentMatchNotFoundError } from '../../src/domain/errors/TournamentMatchNotFoundError'
import { InMemoryTournamentEncounterRepository } from '../../src/adapters/outbound/persistence/InMemoryTournamentEncounterRepository'
import type { TournamentEncounterSourcePort } from '../../src/application/ports/TournamentEncounterSourcePort'
import type {
  CombatRecordPort,
  CombatRoomRecord,
} from '../../src/application/ports/CombatRecordPort'
import { EnsureTournamentMatchesSeeded } from '../../src/application/use-cases/EnsureTournamentMatchesSeeded'
import { ProjectCombatRecord } from '../../src/application/use-cases/ProjectCombatRecord'
import { ListTournamentMatches } from '../../src/application/use-cases/ListTournamentMatches'
import {
  GetTournamentMatchDetail,
  MATCH_EVENTS_PAGE_SIZE,
} from '../../src/application/use-cases/GetTournamentMatchDetail'

const team = (teamId: string, teamLabel: string, playerId: string, heroId: string) => ({
  teamId,
  teamLabel,
  participants: [{ playerId, heroId }],
})

/** Fuente de bracket de prueba: dos torneos, cada uno con sus propias justas. */
class StubEncounterSource implements TournamentEncounterSourcePort {
  listEncounters(tournamentId: string): Promise<readonly TournamentEncounter[]> {
    const e1: TournamentEncounter = {
      tournamentId,
      encounterId: 'E1',
      round: 1,
      bracketLabel: 'E1',
      teams: [team('a1', 'A', 'p1', 'h1'), team('b1', 'B', 'p2', 'h2')],
      status: TournamentMatchStatus.Ready,
      combatRoomId: null,
      startedAt: null,
      closedAt: null,
      result: null,
      lastSyncedSeq: 0,
      logComplete: false,
    }

    const e2: TournamentEncounter = {
      ...e1,
      encounterId: 'E2',
      bracketLabel: 'E2',
      combatRoomId: `room-${tournamentId}-E2`,
    }

    const e3: TournamentEncounter = {
      ...e1,
      encounterId: 'E3',
      bracketLabel: 'E3',
      combatRoomId: `room-${tournamentId}-E3`,
    }

    const e4: TournamentEncounter = {
      ...e1,
      encounterId: 'E4',
      round: 2,
      bracketLabel: 'E4',
      teams: [],
      status: TournamentMatchStatus.WaitingParticipants,
    }

    return Promise.resolve([e4, e2, e1, e3])
  }
}

/** Doble de Combat con dos salas canonicas: una en curso y otra finalizada. */
class StubCombatRecord implements CombatRecordPort {
  readRecord(roomId: string, afterSeq: number): Promise<CombatRoomRecord> {
    const match = /^room-(.+)-(E\d+)$/.exec(roomId)
    if (match === null) {
      throw new Error('sala desconocida')
    }

    const tournamentId = match[1]!
    const encounterId = match[2]!

    const allEvents = [
      {
        roomId,
        seq: 1,
        type: 'battleStarted',
        occurredAt: new Date('2026-09-30T20:00:00Z'),
        payload: {},
      },
      {
        roomId,
        seq: 2,
        type: 'turnResolved',
        occurredAt: new Date('2026-09-30T20:01:00Z'),
        payload: {},
      },
      {
        roomId,
        seq: 3,
        type: 'turnResolved',
        occurredAt: new Date('2026-09-30T20:02:00Z'),
        payload: {},
      },
    ]

    if (encounterId === 'E2') {
      const events = allEvents.filter((event) => event.seq > afterSeq)

      return Promise.resolve({
        roomId,
        tournamentId,
        encounterId,
        status: 'IN_BATTLE',
        startedAt: new Date('2026-09-30T20:00:00Z'),
        result: null,
        afterSeq,
        lastSeq: allEvents.length,
        events,
      })
    }

    // E3: finalizada con resultado.
    const finishedEvents = [
      ...allEvents,
      {
        roomId,
        seq: 4,
        type: 'battleFinished',
        occurredAt: new Date('2026-09-30T20:05:00Z'),
        payload: { winner: 'A' },
      },
    ]
    const events = finishedEvents.filter((event) => event.seq > afterSeq)

    return Promise.resolve({
      roomId,
      tournamentId,
      encounterId,
      status: 'FINISHED',
      startedAt: new Date('2026-09-30T19:00:00Z'),
      result: {
        winnerTeamLabel: 'A',
        reason: 'OPPONENT_DEFEATED',
        outcome: 'VICTORY',
        finishedAt: new Date('2026-09-30T20:05:00Z'),
      },
      afterSeq,
      lastSeq: finishedEvents.length,
      events,
    })
  }
}

describe('EnsureTournamentMatchesSeeded', () => {
  it('siembra las justas de la fuente y proyecta Combat solo una vez por torneo', async () => {
    const repository = new InMemoryTournamentEncounterRepository()
    const source = new StubEncounterSource()
    const combat = new StubCombatRecord()
    const readSpy = jest.spyOn(combat, 'readRecord')
    const useCase = new EnsureTournamentMatchesSeeded(repository, source, combat)

    await useCase.execute('T1')
    await useCase.execute('T1')

    const encounters = await repository.findAllByTournament('T1')
    expect(encounters).toHaveLength(4)
    // Dos justas con sala vinculada (E2, E3): una llamada de proyeccion cada
    // una, y no se repite en la segunda invocacion porque ya habia datos.
    expect(readSpy).toHaveBeenCalledTimes(2)
  })

  it('no mezcla las justas de dos torneos simultaneos (CA-01)', async () => {
    const repository = new InMemoryTournamentEncounterRepository()
    const source = new StubEncounterSource()
    const combat = new StubCombatRecord()
    const useCase = new EnsureTournamentMatchesSeeded(repository, source, combat)

    await useCase.execute('T1')
    await useCase.execute('T2')

    const t1 = await repository.findAllByTournament('T1')
    const t2 = await repository.findAllByTournament('T2')

    expect(t1.every((e) => e.tournamentId === 'T1')).toBe(true)
    expect(t2.every((e) => e.tournamentId === 'T2')).toBe(true)
    expect(t1).toHaveLength(4)
    expect(t2).toHaveLength(4)
  })
})

describe('ProjectCombatRecord', () => {
  it('rechaza un registro de Combat que no corresponde a la justa pedida', async () => {
    const repository = new InMemoryTournamentEncounterRepository()
    await repository.save({
      tournamentId: 'T1',
      encounterId: 'E2',
      round: 1,
      bracketLabel: 'E2',
      teams: [],
      status: TournamentMatchStatus.Ready,
      combatRoomId: 'room-OTRO-E9',
      startedAt: null,
      closedAt: null,
      result: null,
      lastSyncedSeq: 0,
      logComplete: false,
    })

    const useCase = new ProjectCombatRecord(repository, new StubCombatRecord())

    await expect(useCase.execute('T1', 'E2')).rejects.toThrow(/no corresponde a la justa "T1:E2"/)
  })

  it('no hace nada si la justa todavia no tiene sala vinculada', async () => {
    const repository = new InMemoryTournamentEncounterRepository()
    const encounter: TournamentEncounter = {
      tournamentId: 'T1',
      encounterId: 'E1',
      round: 1,
      bracketLabel: 'E1',
      teams: [],
      status: TournamentMatchStatus.Ready,
      combatRoomId: null,
      startedAt: null,
      closedAt: null,
      result: null,
      lastSyncedSeq: 0,
      logComplete: false,
    }
    await repository.save(encounter)

    const useCase = new ProjectCombatRecord(repository, new StubCombatRecord())
    const result = await useCase.execute('T1', 'E1')

    expect(result).toEqual(encounter)
  })

  it('falla si la justa no existe en absoluto', async () => {
    const repository = new InMemoryTournamentEncounterRepository()
    const useCase = new ProjectCombatRecord(repository, new StubCombatRecord())

    await expect(useCase.execute('T1', 'E1')).rejects.toThrow(/no existe la justa/)
  })
})

describe('ListTournamentMatches (CA-02)', () => {
  it('siembra, ordena por ronda/etiqueta y expone el estado de cada justa', async () => {
    const repository = new InMemoryTournamentEncounterRepository()
    const useCase = new ListTournamentMatches(
      repository,
      new StubEncounterSource(),
      new StubCombatRecord(),
    )

    const matches = await useCase.execute('T1')

    expect(matches.map((m) => m.bracketLabel)).toEqual(['E1', 'E2', 'E3', 'E4'])
    expect(matches.find((m) => m.bracketLabel === 'E1')?.status).toBe(TournamentMatchStatus.Ready)
    expect(matches.find((m) => m.bracketLabel === 'E2')?.status).toBe(
      TournamentMatchStatus.InProgress,
    )
    expect(matches.find((m) => m.bracketLabel === 'E3')?.status).toBe(
      TournamentMatchStatus.Finished,
    )
    expect(matches.find((m) => m.bracketLabel === 'E4')?.status).toBe(
      TournamentMatchStatus.WaitingParticipants,
    )
  })

  it('no modifica nada en un segundo listado (lectura no destructiva, CA-06)', async () => {
    const repository = new InMemoryTournamentEncounterRepository()
    const useCase = new ListTournamentMatches(
      repository,
      new StubEncounterSource(),
      new StubCombatRecord(),
    )

    const first = await useCase.execute('T1')
    const second = await useCase.execute('T1')

    expect(second).toEqual(first)
  })
})

describe('GetTournamentMatchDetail (CA-02, CA-03, CA-04, CA-06)', () => {
  const build = () => {
    const repository = new InMemoryTournamentEncounterRepository()
    return new GetTournamentMatchDetail(
      repository,
      new StubEncounterSource(),
      new StubCombatRecord(),
    )
  }

  it('devuelve el detalle completo con equipos, estado y eventos de una justa en curso sin ganador (CA-04)', async () => {
    const useCase = build()
    const { encounter, events } = await useCase.execute('T1', 'E2', 0)

    expect(encounter.status).toBe(TournamentMatchStatus.InProgress)
    expect(encounter.result).toBeNull()
    expect(encounter.closedAt).toBeNull()
    expect(events.events.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(events.hasMore).toBe(false)
    expect(events.nextSeq).toBe(3)
  })

  it('devuelve el resultado autoritativo de una justa finalizada y pagina sus eventos', async () => {
    const useCase = build()
    const { encounter, events } = await useCase.execute('T1', 'E3', 0)

    expect(encounter.status).toBe(TournamentMatchStatus.Finished)
    expect(encounter.result?.winnerTeamLabel).toBe('A')
    expect(encounter.closedAt).not.toBeNull()
    expect(events.events).toHaveLength(4)
    expect(MATCH_EVENTS_PAGE_SIZE).toBe(100)
  })

  it('paginar desde la mitad del archivo continua donde se quedo (afterSeq)', async () => {
    const useCase = build()
    await useCase.execute('T1', 'E3', 0)
    const { events } = await useCase.execute('T1', 'E3', 2)

    expect(events.events.map((e) => e.seq)).toEqual([3, 4])
  })

  /** CA-03: reenviar la consulta tras el cierre no cambia el resultado ya fijado. */
  it('consultar de nuevo tras el cierre conserva el mismo resultado unico', async () => {
    const useCase = build()
    const first = await useCase.execute('T1', 'E3', 0)
    const second = await useCase.execute('T1', 'E3', 0)

    expect(second.encounter.result).toEqual(first.encounter.result)
    expect(second.encounter.closedAt).toEqual(first.encounter.closedAt)
    expect(second.events.events).toEqual(first.events.events)
  })

  /** CA-06: identificador de justa inexistente. */
  it('rechaza una justa inexistente con un 404 de dominio', async () => {
    const useCase = build()

    await expect(useCase.execute('T1', 'E99', 0)).rejects.toBeInstanceOf(
      TournamentMatchNotFoundError,
    )
  })

  /** CA-06: identificador de justa que pertenece a OTRO torneo. */
  it('rechaza el identificador de una justa de otro torneo sin exponer su registro', async () => {
    const useCase = build()

    await useCase.execute('T1', 'E2', 0) // siembra T1
    await useCase.execute('T2', 'E2', 0) // siembra T2, independiente

    await expect(useCase.execute('T1', 'E2:no-existe-en-t1', 0)).rejects.toBeInstanceOf(
      TournamentMatchNotFoundError,
    )
  })

  it('una justa esperando participantes no tiene equipos ni sala vinculada', async () => {
    const useCase = build()
    const { encounter } = await useCase.execute('T1', 'E4', 0)

    expect(encounter.status).toBe(TournamentMatchStatus.WaitingParticipants)
    expect(encounter.teams).toEqual([])
    expect(encounter.combatRoomId).toBeNull()
  })
})
