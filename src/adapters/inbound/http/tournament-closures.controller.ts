import { Body, Controller, HttpCode, HttpException, Inject, Param, Post } from '@nestjs/common'
import { IsString, MaxLength, MinLength } from 'class-validator'
import { Role, type VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import {
  TOURNAMENT_CLOSURES,
  type TournamentClosures,
} from '../../../application/use-cases/TournamentClosures'
import { RegistrationError } from '../../../domain/registration'
import { CurrentIdentity, Roles } from './auth/decorators'

class CloseTournamentDto {
  @IsString() @MinLength(1) @MaxLength(100) operationId!: string
}
@Controller('v1/tournaments/admin')
export class TournamentClosuresController {
  constructor(@Inject(TOURNAMENT_CLOSURES) private readonly closures: TournamentClosures) {}
  @Roles(Role.Administrator)
  @Post(':id/close')
  @HttpCode(200)
  async close(
    @Param('id') id: string,
    @CurrentIdentity() actor: VerifiedIdentity,
    @Body() body: CloseTournamentDto,
  ) {
    try {
      return await this.closures.close(id, actor.subject, body.operationId)
    } catch (error) {
      if (error instanceof RegistrationError)
        throw new HttpException({ code: error.code, message: error.message }, error.status)
      throw error
    }
  }
}
