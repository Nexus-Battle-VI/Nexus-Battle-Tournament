import type { Champion, ConfirmedMatchResult, ProgressBracket } from '../../domain/progression'
import type { PrizeConfiguration, PrizeDelivery, PrizeGrant } from '../../domain/prize'
export const LIFECYCLE_REPOSITORY = Symbol('LifecycleRepository')
export const PRIZE_DESTINATION = Symbol('TournamentPrizeDestination')
export interface TournamentLifecycle {
  tournamentId: string
  results: ConfirmedMatchResult[]
  champion: Champion | null
  configuration: PrizeConfiguration | null
  delivery: PrizeDelivery | null
}
export const emptyLifecycle = (id: string): TournamentLifecycle => ({
  tournamentId: id,
  results: [],
  champion: null,
  configuration: null,
  delivery: null,
})
export interface LifecycleRepository {
  read(tournamentId: string): Promise<TournamentLifecycle>
  change<T>(tournamentId: string, action: (state: TournamentLifecycle) => T): Promise<T>
  pendingDeliveries(): Promise<string[]>
}
/** HU-85 consume participantes resueltos; este puerto no inicia sus salas. */
export interface EncounterProgress {
  bracket(id: string): Promise<ProgressBracket | null>
  confirm(tournamentId: string, encounterId: string): Promise<void>
}
export interface TournamentPrizeDestination {
  grant(command: PrizeGrant): Promise<unknown>
}
