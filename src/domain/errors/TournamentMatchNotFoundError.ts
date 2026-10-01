import { DomainError } from './DomainError'

/**
 * No existe una justa con ese identificador para ese torneo.
 *
 * Deliberadamente el mismo error tanto si el identificador no existe en
 * absoluto como si existe mas pertenece a otro torneo (CA-06 de HU-83,
 * Management#465): distinguir las dos respuestas revelaria que una justa
 * ajena existe en algun lado, que es exactamente lo que CA-06 prohibe mostrar.
 */
export class TournamentMatchNotFoundError extends DomainError {
  constructor(tournamentId: string, matchId: string) {
    super(`No existe la justa "${matchId}" del torneo "${tournamentId}".`)
    this.name = 'TournamentMatchNotFoundError'
  }
}
