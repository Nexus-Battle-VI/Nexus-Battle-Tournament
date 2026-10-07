import type { MatchRead } from '../../domain/match-read'
export const TOURNAMENT_MATCH_READ = Symbol('TournamentMatchReadPort')
/** Contrato propuesto: HU-85 debe aportar vinculación y roster al archivo oficial HU-83. */
export interface TournamentMatchReadPort {
  list(tournamentId: string): Promise<readonly MatchRead[]>
  read(tournamentId: string, encounterId: string): Promise<MatchRead | null>
}
