import { confirmMatch, declareChampion, projectBracket } from '../../domain/progression'
import { requireRule } from '../../domain/registration'
import type { ClockPort } from '../ports/ClockPort'
import type { RegistrationRepository } from '../ports/RegistrationPorts'
import type { EncounterProgress, LifecycleRepository } from '../ports/LifecyclePorts'
import type { TournamentMatchReadPort } from '../ports/TournamentMatchReadPort'
import type { TournamentEncounterRepositoryPort } from '../ports/TournamentEncounterRepositoryPort'
import { bracketEncounters } from '../../domain/bracket'
export const PROGRESSIONS = Symbol('Progressions')
export class Progressions implements EncounterProgress {
  constructor(
    readonly repository: LifecycleRepository,
    private readonly tournaments: RegistrationRepository,
    private readonly matches: TournamentMatchReadPort,
    private readonly clock: ClockPort,
    private readonly encounters?: TournamentEncounterRepositoryPort,
  ) {}
  async view(id: string) {
    const tournament = await this.tournaments.read(id),
      state = await this.repository.read(id)
    const bracket = tournament.bracket ? projectBracket(tournament.bracket, state.results) : null
    return {
      bracket,
      champion: state.champion,
      statistics:
        tournament.bracket?.seeds.map((seed) => ({
          teamId: seed.teamId,
          memberIds: seed.memberIds,
          victories: state.results.filter((r) => r.winnerTeamId === seed.teamId).length,
          defeats: state.results.filter((r) => r.loserTeamId === seed.teamId).length,
        })) ?? [],
      eliminatedTeamIds: [
        ...new Set(
          state.results
            .filter(
              (r) =>
                r.loserTeamId !== null &&
                bracket?.matches.find((m) => m.id === r.matchId)?.destinations.loser === null,
            )
            .map((r) => r.loserTeamId),
        ),
      ],
    }
  }
  async bracket(id: string) {
    return (await this.view(id)).bracket
  }
  async confirm(id: string, encounterId: string): Promise<void> {
    const bracket = (await this.tournaments.read(id)).bracket
    requireRule(bracket !== null, 'BRACKET_REQUIRED', 'No hay llaves publicadas.', 409)
    const e = await this.matches.read(id, encounterId)
    requireRule(e !== null, 'MATCH_NOT_FOUND', 'No existe esta justa en el archivo oficial.', 404)
    if (e.status !== 'FINISHED') return
    await this.repository.change(id, (state) => {
      const at = this.clock.now().toISOString()
      confirmMatch(bracket, state.results, e, at)
      state.champion ??= declareChampion(bracket, state.results, e, at)
    })
    await this.resolveTeams(id)
  }
  /** Lleva el avance al mismo archivo HU-83; no crea un segundo módulo de justas. */
  async resolveTeams(id: string): Promise<void> {
    if (this.encounters === undefined) return
    const bracket = await this.bracket(id)
    if (bracket === null) return
    const projected = bracketEncounters({
      ...bracket,
      matches: bracket.matches.map((m) => ({
        ...m,
        status: m.teamIds.every((team) => team !== null)
          ? ('TEAMS_RESOLVED' as const)
          : ('WAITING' as const),
      })),
    })
    for (const seed of projected) {
      const current = await this.encounters.findOne(id, seed.encounterId)
      if (
        current?.bracketMetadata === undefined ||
        current.bracketMetadata.registeredTeams.every((team) => team !== null)
      )
        continue
      await this.encounters.save({
        ...current,
        bracketMetadata: {
          ...current.bracketMetadata,
          registeredTeams: seed.bracketMetadata?.registeredTeams ?? [],
          preparationStatus: seed.bracketMetadata?.preparationStatus ?? 'WAITING_TEAMS',
        },
      })
    }
  }
  async reconcile(): Promise<void> {
    for (const tournament of await this.tournaments.list()) {
      if (tournament.bracket === null) continue
      // Orden topológico del snapshot; una lectura fallida no bloquea otras justas/torneos.
      for (const match of tournament.bracket.matches) {
        try {
          await this.confirm(tournament.id, match.encounterId)
        } catch {
          /* Revisión o dependencia pendiente. */
        }
      }
    }
  }
}
