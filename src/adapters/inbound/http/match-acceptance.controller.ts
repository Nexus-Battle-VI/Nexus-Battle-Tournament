import { Body, Controller, HttpCode, HttpException, Inject, Param, Post } from '@nestjs/common'
import { IsString, MaxLength, MinLength } from 'class-validator'
import { MATCH_ACCEPTANCE, MatchAcceptance } from '../../../application/use-cases/MatchAcceptance'
import { Role, type VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import { RegistrationError } from '../../../domain/registration'
import { CurrentIdentity, Roles } from './auth/decorators'
class AcceptMatchDto {
  @IsString() @MinLength(1) @MaxLength(100) operationId!: string
}
@Controller('v1/tournaments')
export class MatchAcceptanceController {
  constructor(@Inject(MATCH_ACCEPTANCE) private readonly acceptance: MatchAcceptance) {}
  @Post(':tournamentId/matches/:encounterId/acceptance')
  @Roles(Role.Player)
  @HttpCode(200)
  async accept(
    @Param('tournamentId') id: string,
    @Param('encounterId') encounterId: string,
    @CurrentIdentity() actor: VerifiedIdentity,
    @Body() body: AcceptMatchDto,
  ) {
    try {
      return await this.acceptance.accept(id, encounterId, actor.subject, body.operationId)
    } catch (error: unknown) {
      if (error instanceof RegistrationError)
        throw new HttpException({ code: error.code, message: error.message }, error.status)
      throw error
    }
  }
}
