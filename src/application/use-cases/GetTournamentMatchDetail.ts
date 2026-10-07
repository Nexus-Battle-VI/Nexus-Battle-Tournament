import type { CombatEventPage } from '../../domain/entities/CombatEventRecord'
import type { TournamentEncounter } from '../../domain/entities/TournamentEncounter'
import { TournamentMatchNotFoundError } from '../../domain/errors/TournamentMatchNotFoundError'
import { EnsureTournamentMatchesSeeded } from './EnsureTournamentMatchesSeeded'
import type { TournamentEncounterRepositoryPort } from '../ports/TournamentEncounterRepositoryPort'
import type { TournamentEncounterSourcePort } from '../ports/TournamentEncounterSourcePort'
import type { CombatRecordPort } from '../ports/CombatRecordPort'

/** Tope de eventos por pagina. Fijado por el contrato de HU-83 (Management#509). */
export const MATCH_EVENTS_PAGE_SIZE = 100

export interface TournamentMatchDetail {
  readonly encounter: TournamentEncounter
  readonly events: CombatEventPage
}

/**
 * `GET /api/v1/tournaments/:tournamentId/matches/:matchId?afterSeq=0` (CA-02,
 * CA-03, CA-04, CA-06 de HU-83).
 *
 * Una referencia inexistente o de otro torneo se rechaza con el mismo error
 * (`TournamentMatchNotFoundError`), sin distinguir los dos casos: distinguirlos
 * revelaria que una justa ajena existe, que es justo lo que CA-06 prohibe.
 *
 * Lectura no destructiva: no cambia el combate, el resultado ni el bracket.
 */
export class GetTournamentMatchDetail {
  private readonly ensureSeeded: EnsureTournamentMatchesSeeded

  constructor(
    private readonly repository: TournamentEncounterRepositoryPort,
    source: TournamentEncounterSourcePort,
    combat: CombatRecordPort,
  ) {
    this.ensureSeeded = new EnsureTournamentMatchesSeeded(repository, source, combat)
  }

  async execute(
    tournamentId: string,
    matchId: string,
    afterSeq: number,
  ): Promise<TournamentMatchDetail> {
    await this.ensureSeeded.execute(tournamentId)

    const encounter = await this.repository.findOne(tournamentId, matchId)

    if (encounter === null) {
      throw new TournamentMatchNotFoundError(tournamentId, matchId)
    }

    const events = await this.repository.listEvents(
      tournamentId,
      matchId,
      afterSeq,
      MATCH_EVENTS_PAGE_SIZE,
    )

    return { encounter, events }
  }
}
