import type { MatchAcceptanceState, TournamentResolution } from '../../domain/match-acceptance'
export const MATCH_ACCEPTANCE_STORE = Symbol('MatchAcceptanceStore')
export interface MatchAcceptanceStore {
  read(tournamentId: string, encounterId: string): Promise<MatchAcceptanceState | null>
  /** Candado por justa; callback síncrono sin red. Persistir decisión/intención antes de salir. */
  change<T>(initial: MatchAcceptanceState, action: (state: MatchAcceptanceState) => T): Promise<T>
  resolutions(tournamentId: string): Promise<TournamentResolution[]>
}
export interface FairRandomPort {
  bit(): 0 | 1
}
export const FAIR_RANDOM = Symbol('FairRandomPort')
