import {
  TournamentMatchStatus,
  type TournamentEncounter,
} from '../../domain/entities/TournamentEncounter'
import { ProjectCombatRecord } from './ProjectCombatRecord'
import type { TournamentEncounterSourcePort } from '../ports/TournamentEncounterSourcePort'
import type { TournamentEncounterRepositoryPort } from '../ports/TournamentEncounterRepositoryPort'
import type { CombatRecordPort } from '../ports/CombatRecordPort'

/**
 * Da de alta, en la persistencia PROPIA de Tournament, las justas que todavia
 * no tiene para un torneo, leyendolas de `TournamentEncounterSourcePort`, y
 * proyecta sobre ellas lo que `CombatRecordPort` ya sepa.
 *
 * La publicación HU-78 ya materializa las catorce filas en su transacción.
 * El sembrado perezoso conserva compatibilidad con otras implementaciones
 * del puerto, incluidos los dobles seleccionados por la suite histórica.
 *
 * El SEMBRADO (leer `TournamentEncounterSourcePort` y crear las filas) ocurre
 * una UNICA vez por torneo: si ya hay justas persistidas, no se vuelve a
 * generar. La PROYECCION de Combat es otra cosa: se reintenta en CADA
 * invocacion para toda justa con sala vinculada que no este `FINISHED`
 * todavia. Si no se reintentara, una justa que avanzara en Combat despues de
 * la primera consulta quedaria congelada para siempre en Tournament (un
 * `IN_PROGRESS` que Combat ya cerro jamas se reflejaria). Reintentar es
 * seguro y barato: `ProjectCombatRecord` pide solo lo nuevo a partir de
 * `lastSyncedSeq`/`afterSeq`, y la restriccion unica de secuencia en
 * `tournament_combat_events` impide duplicar eventos ya proyectados, asi que
 * no hace falta ningun mecanismo de deduplicacion propio. Una vez que una
 * justa llega a `FINISHED` es terminal (`applyCombatProjection`), asi que
 * se sigue completando su bitácora mientras `logComplete` sea falso.
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

    const encounters = existing.length > 0 ? existing : await this.seed(tournamentId)

    await this.reprojectPending(tournamentId, encounters)
  }

  /** Sembrado perezoso, una sola vez por torneo: crea las justas que todavia no existen. */
  private async seed(tournamentId: string): Promise<readonly TournamentEncounter[]> {
    const seeds = await this.source.listEncounters(tournamentId)

    await Promise.all(seeds.map((seed) => this.repository.save(seed)))

    return seeds
  }

  /**
   * Reintenta la proyeccion de Combat para cada justa con sala vinculada que
   * no haya terminado de archivarse. Se llama en CADA `execute`, no solo cuando se
   * acaba de sembrar, para que el estado de Tournament no quede congelado.
   */
  private async reprojectPending(
    tournamentId: string,
    encounters: readonly TournamentEncounter[],
  ): Promise<void> {
    const pending = encounters.filter(
      (encounter) =>
        encounter.combatRoomId !== null &&
        (encounter.status !== TournamentMatchStatus.Finished || !encounter.logComplete),
    )

    await Promise.all(
      pending.map((encounter) =>
        this.projector.execute(tournamentId, encounter.encounterId).catch(() => undefined),
      ),
    )
  }
}
