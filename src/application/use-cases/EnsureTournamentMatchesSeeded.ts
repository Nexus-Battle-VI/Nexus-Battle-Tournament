import { ProjectCombatRecord } from './ProjectCombatRecord'
import type { TournamentEncounterSourcePort } from '../ports/TournamentEncounterSourcePort'
import type { TournamentEncounterRepositoryPort } from '../ports/TournamentEncounterRepositoryPort'
import type { CombatRecordPort } from '../ports/CombatRecordPort'

/**
 * Da de alta, en la persistencia PROPIA de Tournament, las justas que todavia
 * no tiene para un torneo, leyendolas de `TournamentEncounterSourcePort`, y
 * proyecta sobre ellas lo que `CombatRecordPort` ya sepa.
 *
 * Existe porque HU-78 (bracket) y HU-85 (vinculo con la sala) no estan
 * implementadas todavia: sin este paso, `tournament_encounters` estaria
 * siempre vacia y no habria nada que listar o consultar. El dia que existan,
 * este caso de uso deja de hacer falta tal como esta — lo normal sera que algo
 * (un evento de bracket generado, o el propio HU-85 al vincular una sala)
 * dispare `save`/`ProjectCombatRecord` directamente. Mientras tanto, se invoca
 * de forma perezosa antes de listar o consultar (`ListTournamentMatches`,
 * `GetTournamentMatchDetail`), una vez por torneo: si ya hay justas
 * persistidas para ese torneo, no vuelve a sembrar.
 *
 * NO MUTA nada en Combat ni en el bracket: solo lee de los dos puertos y
 * escribe en el almacen propio de Tournament. Cumple la misma restriccion que
 * el resto de la lectura de HU-83 (CA-06: "la lectura no modifica el combate,
 * el resultado ni el bracket").
 */
export class EnsureTournamentMatchesSeeded {
  private readonly projector: ProjectCombatRecord

  constructor(
    private readonly repository: TournamentEncounterRepositoryPort,
    private readonly source: TournamentEncounterSourcePort,
    combat: CombatRecordPort,
  ) {
    this.projector = new ProjectCombatRecord(repository, combat)
  }

  async execute(tournamentId: string): Promise<void> {
    const existing = await this.repository.findAllByTournament(tournamentId)

    if (existing.length > 0) {
      return
    }

    const seeds = await this.source.listEncounters(tournamentId)

    for (const seed of seeds) {
      await this.repository.save(seed)
    }

    for (const seed of seeds) {
      if (seed.combatRoomId !== null) {
        await this.projector.execute(seed.tournamentId, seed.encounterId)
      }
    }
  }
}
