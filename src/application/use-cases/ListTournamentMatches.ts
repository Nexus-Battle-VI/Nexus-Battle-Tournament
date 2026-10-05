import type { TournamentEncounter } from '../../domain/entities/TournamentEncounter'
import { EnsureTournamentMatchesSeeded } from './EnsureTournamentMatchesSeeded'
import type { TournamentEncounterRepositoryPort } from '../ports/TournamentEncounterRepositoryPort'
import type { TournamentEncounterSourcePort } from '../ports/TournamentEncounterSourcePort'
import type { CombatRecordPort } from '../ports/CombatRecordPort'

/**
 * `GET /api/v1/tournaments/:tournamentId/matches` (CA-02 de HU-83).
 *
 * Lista no destructiva: no cambia nada de la justa, el combate ni el bracket.
 * El orden es por ronda y despues por etiqueta del bracket, para que el
 * listado sea estable entre llamadas aunque las justas de distintas rondas se
 * hayan sembrado en otro orden.
 */
export class ListTournamentMatches {
  private readonly ensureSeeded: EnsureTournamentMatchesSeeded

  constructor(
    private readonly repository: TournamentEncounterRepositoryPort,
    source: TournamentEncounterSourcePort,
    combat: CombatRecordPort,
  ) {
    this.ensureSeeded = new EnsureTournamentMatchesSeeded(repository, source, combat)
  }

  async execute(tournamentId: string): Promise<readonly TournamentEncounter[]> {
    await this.ensureSeeded.execute(tournamentId)

    const encounters = await this.repository.findAllByTournament(tournamentId)

    return [...encounters].sort(
      (a, b) => a.round - b.round || a.bracketLabel.localeCompare(b.bracketLabel),
    )
  }
}
