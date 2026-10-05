import { Controller, Get, Inject, NotFoundException, Param, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'

import { TournamentMatchNotFoundError } from '../../../domain/errors/TournamentMatchNotFoundError'
import { GetTournamentMatchDetail } from '../../../application/use-cases/GetTournamentMatchDetail'
import { ListTournamentMatches } from '../../../application/use-cases/ListTournamentMatches'
import {
  MatchDetailQueryDto,
  toMatchDetailResponse,
  toMatchSummaryResponse,
  type MatchDetailResponse,
  type MatchSummaryResponse,
} from './dto/tournament-match.dto'
import { GET_TOURNAMENT_MATCH_DETAIL, LIST_TOURNAMENT_MATCHES } from './tokens.tournament-matches'

/**
 * HU-83 (Management#465): registro y consulta de las justas de un torneo.
 *
 * Lectura autenticada y no destructiva: ninguna de las dos rutas cambia el
 * combate, el resultado o el bracket (CA-06). No hay rutas de administracion
 * aqui — preparar/iniciar una justa es HU-85, fuera de alcance de esta
 * historia.
 */
@ApiTags('tournament-matches')
@Controller('v1/tournaments')
export class TournamentMatchesController {
  constructor(
    @Inject(LIST_TOURNAMENT_MATCHES) private readonly listMatches: ListTournamentMatches,
    @Inject(GET_TOURNAMENT_MATCH_DETAIL) private readonly matchDetail: GetTournamentMatchDetail,
  ) {}

  @Get(':tournamentId/matches')
  @ApiOperation({ summary: 'Lista las justas de un torneo con su estado (CA-02)' })
  async list(
    @Param('tournamentId') tournamentId: string,
  ): Promise<readonly MatchSummaryResponse[]> {
    const encounters = await this.listMatches.execute(tournamentId)

    return encounters.map(toMatchSummaryResponse)
  }

  @Get(':tournamentId/matches/:matchId')
  @ApiOperation({
    summary:
      'Detalle de una justa: equipos, heroes, estado, resultado y una pagina de eventos (CA-02 a CA-04, CA-06)',
  })
  async detail(
    @Param('tournamentId') tournamentId: string,
    @Param('matchId') matchId: string,
    @Query() query: MatchDetailQueryDto,
  ): Promise<MatchDetailResponse> {
    const afterSeq = query.afterSeq ?? 0

    try {
      const { encounter, events } = await this.matchDetail.execute(tournamentId, matchId, afterSeq)

      return toMatchDetailResponse(encounter, events, afterSeq)
    } catch (error) {
      if (error instanceof TournamentMatchNotFoundError) {
        // Referencia inexistente o de otro torneo: 404 sin exponer el registro
        // de una justa ajena (CA-06).
        throw new NotFoundException(error.message)
      }

      throw error
    }
  }
}
