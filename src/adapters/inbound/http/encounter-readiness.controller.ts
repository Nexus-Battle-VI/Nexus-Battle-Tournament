import { Controller, Get, HttpCode, HttpException, Inject, Param, Post } from '@nestjs/common'

import {
  ENCOUNTER_ABSENCES,
  EncounterAbsences,
} from '../../../application/use-cases/EncounterAbsences'
import type { VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import { RegistrationError } from '../../../domain/registration'
import { CurrentIdentity } from './auth/decorators'

/**
 * Ventana de aceptación del combate (decisión de Carlos sobre HU-85): los
 * integrantes de los dos equipos aceptan desde su propia sesión; el jugador sale
 * del JWT verificado, nunca del cuerpo.
 */
@Controller('v1/tournaments')
export class EncounterReadinessController {
  constructor(@Inject(ENCOUNTER_ABSENCES) private readonly absences: EncounterAbsences) {}

  private async respond<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action()
    } catch (error: unknown) {
      if (error instanceof RegistrationError)
        throw new HttpException({ code: error.code, message: error.message }, error.status)
      throw error
    }
  }

  @Post(':tournamentId/matches/:matchId/ready')
  @HttpCode(200)
  accept(
    @Param('tournamentId') tournamentId: string,
    @Param('matchId') matchId: string,
    @CurrentIdentity() identity: VerifiedIdentity,
  ) {
    return this.respond(() => this.absences.accept(tournamentId, matchId, identity.subject))
  }

  @Get(':tournamentId/matches/:matchId/readiness')
  readiness(@Param('tournamentId') tournamentId: string, @Param('matchId') matchId: string) {
    return this.respond(() => this.absences.view(tournamentId, matchId))
  }
}
