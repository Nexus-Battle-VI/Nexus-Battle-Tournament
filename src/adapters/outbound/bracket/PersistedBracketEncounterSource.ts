import type { TournamentEncounterSourcePort } from '../../../application/ports/TournamentEncounterSourcePort'
import type { RegistrationRepository } from '../../../application/ports/RegistrationPorts'
import { RegistrationError } from '../../../domain/registration'
import { bracketEncounters } from '../../../domain/bracket'
export class PersistedBracketEncounterSource implements TournamentEncounterSourcePort {
  constructor(private readonly registrations: RegistrationRepository) {}
  async listEncounters(tournamentId: string) {
    try {
      const t = await this.registrations.read(tournamentId)
      return t.bracket === null ? [] : bracketEncounters(t.bracket)
    } catch (error: unknown) {
      if (error instanceof RegistrationError && error.code === 'TOURNAMENT_NOT_FOUND') return []
      throw error
    }
  }
}
