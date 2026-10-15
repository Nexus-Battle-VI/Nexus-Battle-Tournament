import {
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Optional,
  Param,
  Query,
} from '@nestjs/common'
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
import {
  MATCH_ACCEPTANCE,
  type MatchAcceptance,
} from '../../../application/use-cases/MatchAcceptance'
import { CurrentIdentity } from './auth/decorators'
import { Role, type VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import type { TournamentEncounter } from '../../../domain/entities/TournamentEncounter'
import {
  TOURNAMENT_CLOSURES,
  type TournamentClosures,
} from '../../../application/use-cases/TournamentClosures'

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
    @Optional() @Inject(MATCH_ACCEPTANCE) private readonly acceptance?: MatchAcceptance,
    @Optional() @Inject(TOURNAMENT_CLOSURES) private readonly closures?: TournamentClosures,
  ) {}

  @Get(':tournamentId/matches')
  @ApiOperation({ summary: 'Lista las justas de un torneo con su estado (CA-02)' })
  async list(
    @Param('tournamentId') tournamentId: string,
    @CurrentIdentity() actor?: VerifiedIdentity,
  ): Promise<readonly MatchSummaryResponse[]> {
    const encounters = await this.listMatches.execute(tournamentId)

    return Promise.all(
      encounters.map(async (e) => this.enrich(e, toMatchSummaryResponse(e), actor?.subject)),
    )
  }

  @Get(':tournamentId/matches/mine')
  @ApiOperation({ summary: 'Historial personal de batallas del jugador autenticado' })
  async ownList(@Param('tournamentId') id: string, @CurrentIdentity() actor: VerifiedIdentity) {
    const encounters = await this.listMatches.execute(id)
    return Promise.all(
      encounters
        .filter((e) => this.belongs(e, actor.subject))
        .map(async (e) => ({
          ...(await this.enrich(e, toMatchSummaryResponse(e), actor.subject)),
          myBattle: true,
        })),
    )
  }

  @Get(':tournamentId/matches/mine/:matchId')
  @ApiOperation({ summary: 'Detalle y acciones de una batalla propia' })
  async ownDetail(
    @Param('tournamentId') id: string,
    @Param('matchId') matchId: string,
    @Query() query: MatchDetailQueryDto,
    @CurrentIdentity() actor: VerifiedIdentity,
  ) {
    const encounter = (await this.listMatches.execute(id)).find((e) => e.encounterId === matchId)
    if (encounter === undefined) throw new NotFoundException('La batalla no existe.')
    if (!this.belongs(encounter, actor.subject))
      throw new ForbiddenException('Esta batalla no pertenece a tu historial.')
    return { ...(await this.detail(id, matchId, query, actor)), myBattle: true }
  }

  private belongs(e: TournamentEncounter, subject: string): boolean {
    return (
      e.teams.some((team) => team.participants.some((p) => p.playerId === subject)) ||
      (e.bracketMetadata?.registeredTeams.some((team) => team?.memberIds.includes(subject)) ??
        false)
    )
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
    @CurrentIdentity() actor?: VerifiedIdentity,
  ): Promise<MatchDetailResponse> {
    const afterSeq = query.afterSeq ?? 0
    const reference = (await this.listMatches.execute(tournamentId)).find(
      (e) => e.encounterId === matchId,
    )
    if (reference === undefined) throw new NotFoundException('La batalla no existe.')
    if (
      actor === undefined ||
      (!this.belongs(reference, actor.subject) &&
        !actor.roles.has(Role.Administrator) &&
        !actor.roles.has(Role.SuperAdministrator))
    )
      throw new ForbiddenException('Solo puedes consultar el historial de tus batallas.')

    try {
      const { encounter, events } = await this.matchDetail.execute(tournamentId, matchId, afterSeq)

      return await this.enrich(
        encounter,
        toMatchDetailResponse(encounter, events, afterSeq),
        actor.subject,
      )
    } catch (error) {
      if (error instanceof TournamentMatchNotFoundError) {
        // Referencia inexistente o de otro torneo: 404 sin exponer el registro
        // de una justa ajena (CA-06).
        throw new NotFoundException(error.message)
      }

      throw error
    }
  }
  private async enrich<T extends MatchSummaryResponse>(
    e: TournamentEncounter,
    response: T,
    subject?: string,
  ): Promise<T> {
    if (
      e.bracketMetadata?.acceptancePolicy !== 'ROUND_ACCEPTANCE_V1' ||
      this.acceptance === undefined
    )
      return (await this.closures?.isClosed(e.tournamentId).catch(() => false))
        ? { ...response, operationalStatus: 'TOURNAMENT_CLOSED' }
        : response
    const projection = await this.acceptance.view(e.tournamentId, e.encounterId, subject)
    if (projection === null) return response
    return {
      ...response,
      ...projection,
      ...(e.status === 'FINISHED' &&
      projection.resolution === null &&
      projection.operationalStatus !== 'TOURNAMENT_CLOSED'
        ? { operationalStatus: 'RESOLUTION_PENDING' }
        : {}),
      ...(projection.resolution?.resultType === 'ABSENCE'
        ? { status: 'FINISHED', closedAt: projection.resolution.resolvedAt }
        : {}),
    }
  }
}
