import { Body, Controller, Get, HttpCode, HttpException, Inject, Param, Post } from '@nestjs/common'
import { IsString, MaxLength, MinLength } from 'class-validator'

import {
  ENCOUNTER_ADMINISTRATION,
  EncounterAdministration,
} from '../../../application/use-cases/EncounterAdministration'
import { Role, type VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import { CombatRejectedError } from '../../../domain/encounter-admin'
import { RegistrationError } from '../../../domain/registration'
import { CurrentIdentity, Roles } from './auth/decorators'

class EncounterActionDto {
  @IsString() @MinLength(1) @MaxLength(100) operationId!: string
}

/**
 * HU-85 (Management#470): administracion de justas independientes. Solo
 * administradores; el actor sale del testimonio verificado, nunca del cuerpo.
 * Las lecturas de HU-83 no cambian.
 */
@Controller('v1/tournaments/admin')
export class EncounterAdminController {
  constructor(
    @Inject(ENCOUNTER_ADMINISTRATION) private readonly administration: EncounterAdministration,
  ) {}

  private async respond<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action()
    } catch (error: unknown) {
      if (error instanceof CombatRejectedError)
        throw new HttpException(
          { code: error.code, message: error.message, blockers: error.blockers },
          error.status,
        )
      if (error instanceof RegistrationError)
        throw new HttpException({ code: error.code, message: error.message }, error.status)
      throw error
    }
  }

  @Roles(Role.Administrator)
  @Post(':tournamentId/matches/:matchId/prepare')
  @HttpCode(200)
  prepare(
    @Param('tournamentId') tournamentId: string,
    @Param('matchId') matchId: string,
    @CurrentIdentity() actor: VerifiedIdentity,
    @Body() body: EncounterActionDto,
  ) {
    return this.respond(() =>
      this.administration.prepare(tournamentId, matchId, actor.subject, body.operationId),
    )
  }

  @Roles(Role.Administrator)
  @Post(':tournamentId/matches/:matchId/start')
  @HttpCode(200)
  start(
    @Param('tournamentId') tournamentId: string,
    @Param('matchId') matchId: string,
    @CurrentIdentity() actor: VerifiedIdentity,
    @Body() body: EncounterActionDto,
  ) {
    return this.respond(() =>
      this.administration.start(tournamentId, matchId, actor.subject, body.operationId),
    )
  }

  @Roles(Role.Administrator)
  @Get(':tournamentId/actions')
  actions(@Param('tournamentId') tournamentId: string) {
    return this.respond(async () => ({ actions: await this.administration.list(tournamentId) }))
  }
}
