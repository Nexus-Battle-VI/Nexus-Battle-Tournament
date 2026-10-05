import type { RegistrationRepository } from '../../../application/ports/RegistrationPorts'
import { sameJson } from '../../../domain/json'
import type { TournamentEncounterRepositoryPort } from '../../../application/ports/TournamentEncounterRepositoryPort'
import {
  RegistrationError,
  CALENDAR_DISTANCE_MS,
  type RegistrationTournament,
} from '../../../domain/registration'
import { bracketEncounters } from '../../../domain/bracket'

/** Doble de pruebas: el proceso no sustituye la persistencia de producción. */
export class InMemoryRegistrationRepository implements RegistrationRepository {
  private readonly tournaments = new Map<string, RegistrationTournament>()
  private readonly adminOperations = new Map<string, { intent: string; tournamentId: string }>()
  private readonly tails = new Map<string, Promise<void>>()
  constructor(private readonly encounters: TournamentEncounterRepositoryPort) {}
  list(): Promise<RegistrationTournament[]> {
    return Promise.resolve(structuredClone([...this.tournaments.values()]))
  }
  create(
    t: RegistrationTournament,
    operationId: string,
    intent: string,
  ): Promise<RegistrationTournament> {
    const existing = this.adminOperations.get(operationId)
    if (existing !== undefined) {
      if (existing.intent !== intent)
        return Promise.reject(new RegistrationError('OPERATION_CONFLICT', 'Otra intención.', 409))
      return this.read(existing.tournamentId)
    }
    if (
      [...this.tournaments.values()].some(
        (x) =>
          Math.abs(new Date(x.startsAt).getTime() - new Date(t.startsAt).getTime()) <
          CALENDAR_DISTANCE_MS,
      )
    )
      return Promise.reject(
        new RegistrationError(
          'CALENDAR_CONFLICT',
          'Los inicios deben tener 91 días de separación.',
          409,
        ),
      )
    this.tournaments.set(t.id, structuredClone(t))
    this.adminOperations.set(operationId, { intent, tournamentId: t.id })
    return Promise.resolve(structuredClone(t))
  }
  read(id: string): Promise<RegistrationTournament> {
    const t = this.tournaments.get(id)
    return t === undefined
      ? Promise.reject(new RegistrationError('TOURNAMENT_NOT_FOUND', 'El torneo no existe.', 404))
      : Promise.resolve(structuredClone(t))
  }
  async change<T>(id: string, action: (t: RegistrationTournament) => T): Promise<T> {
    const prior = this.tails.get(id) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    this.tails.set(id, next)
    await prior
    try {
      const t = await this.read(id)
      const previousBracket = structuredClone(t.bracket)
      const result = action(t)
      if (previousBracket !== null && !sameJson(previousBracket, t.bracket))
        throw new RegistrationError(
          'IMMUTABLE_BRACKET',
          'Las llaves publicadas son inmutables.',
          409,
        )
      if (previousBracket === null && t.bracket !== null) {
        const seeds = bracketEncounters(t.bracket)
        for (const seed of seeds)
          if ((await this.encounters.findOne(id, seed.encounterId)) !== null)
            throw new RegistrationError(
              'ENCOUNTER_IDENTITY_CONFLICT',
              'La identidad ya está archivada.',
              409,
            )
        for (const seed of seeds) await this.encounters.save(seed)
      }
      this.tournaments.set(id, t)
      return structuredClone(result)
    } finally {
      release()
      if (this.tails.get(id) === next) this.tails.delete(id)
    }
  }
}
