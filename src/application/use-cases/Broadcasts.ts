import { broadcastSnapshot, type BroadcastState } from '../../domain/broadcast'
import { RegistrationError, requireRule } from '../../domain/registration'
import type { BroadcastRepository } from '../ports/BroadcastPorts'
import type { RegistrationRepository } from '../ports/RegistrationPorts'
import type { ClockPort } from '../ports/ClockPort'
import type { TournamentMatchReadPort } from '../ports/TournamentMatchReadPort'
export const BROADCASTS = Symbol('Broadcasts')
const authorized = (state: BroadcastState, actor: string): void => {
  requireRule(
    state.broadcasterId === actor,
    'BROADCAST_FORBIDDEN',
    'Solo el administrador designado puede observar o cambiar la justa.',
    403,
  )
}
const revisionMatches = (state: BroadcastState, revision: number): void => {
  requireRule(
    state.revision === revision,
    'BROADCAST_CHANGED',
    'La selección o el transmisor cambiaron. Actualiza la vista.',
    409,
  )
}
export class Broadcasts {
  constructor(
    readonly repository: BroadcastRepository,
    private readonly tournaments: RegistrationRepository,
    private readonly encounters: TournamentMatchReadPort,
    private readonly clock: ClockPort,
  ) {}
  async configuration(id: string) {
    await this.tournaments.read(id)
    return this.repository.read(id)
  }
  async designate(id: string, actor: string, expectedRevision?: number): Promise<BroadcastState> {
    await this.tournaments.read(id)
    return this.repository.change(id, (state) => {
      if (state.broadcasterId === actor) return structuredClone(state)
      if (expectedRevision !== undefined) revisionMatches(state, expectedRevision)
      else
        requireRule(
          state.broadcasterId === null,
          'BROADCASTER_EXISTS',
          'Ya existe un transmisor. Se requiere una sustitución explícita.',
          409,
        )
      state.broadcasterId = actor
      state.revision++
      return structuredClone(state)
    })
  }
  private async fromCombat<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read()
    } catch (error: unknown) {
      if (error instanceof RegistrationError) throw error
      throw new RegistrationError(
        'COMBAT_UNAVAILABLE',
        'Vista desconectada de Combat. Se conserva la justa seleccionada.',
        503,
      )
    }
  }
  private async snapshot(id: string, matchId: string) {
    const e = await this.fromCombat(() => this.encounters.read(id, matchId))
    requireRule(e !== null, 'MATCH_NOT_FOUND', 'La justa no pertenece a este torneo.', 404)
    return broadcastSnapshot(e, await this.tournaments.read(id), this.clock.now().toISOString())
  }
  async select(id: string, matchId: string, actor: string, expectedRevision: number) {
    const before = await this.configuration(id)
    authorized(before, actor)
    revisionMatches(before, expectedRevision)
    const snapshot = await this.snapshot(id, matchId)
    requireRule(
      snapshot.status === 'IN_PROGRESS' || before.selectedMatchId === matchId,
      'MATCH_NOT_ACTIVE',
      'Solo puedes cambiar a una justa en curso.',
      409,
    )
    const state = await this.repository.change(id, (current) => {
      authorized(current, actor)
      revisionMatches(current, expectedRevision)
      if (current.selectedMatchId !== matchId) {
        current.selectedMatchId = matchId
        current.revision++
      }
      return structuredClone(current)
    })
    return { state, snapshot }
  }
  async observe(id: string, actor: string) {
    const state = await this.configuration(id)
    authorized(state, actor)
    const snapshot =
      state.selectedMatchId === null ? null : await this.snapshot(id, state.selectedMatchId)
    const current = await this.repository.read(id)
    authorized(current, actor)
    revisionMatches(current, state.revision)
    return { state, snapshot }
  }
  async active(id: string, actor: string) {
    authorized(await this.configuration(id), actor)
    const t = await this.tournaments.read(id)
    const matches = await this.fromCombat(() => this.encounters.list(id))
    authorized(await this.configuration(id), actor)
    return {
      matches: matches
        .filter((m) => m.status === 'IN_PROGRESS')
        .map((m) => ({
          matchId: m.encounterId,
          encounterId: m.encounterId,
          bracketLabel: m.bracketLabel,
          track: m.track,
          round: m.round,
          teams: m.teams.map((team) => ({
            teamId: team.teamId,
            name: t.bracket?.seeds.find((s) => s.teamId === team.teamId)?.name ?? team.teamId,
          })),
        })),
    }
  }
}
