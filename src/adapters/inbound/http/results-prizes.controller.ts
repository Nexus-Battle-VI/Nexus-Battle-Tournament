import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
} from '@nestjs/common'
import { PROGRESSIONS, Progressions } from '../../../application/use-cases/Progressions'
import { PRIZES, Prizes } from '../../../application/use-cases/Prizes'
import { Role, type VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import { RegistrationError } from '../../../domain/registration'
import { CurrentIdentity, Roles } from './auth/decorators'
const respond = async <T>(action: () => Promise<T>): Promise<T> => {
  try {
    return await action()
  } catch (error: unknown) {
    if (error instanceof RegistrationError)
      throw new HttpException({ code: error.code, message: error.message }, error.status)
    throw error
  }
}
@Controller('v1/tournaments')
export class ResultsPrizesController {
  constructor(
    @Inject(PROGRESSIONS) private readonly progress: Progressions,
    @Inject(PRIZES) private readonly prizes: Prizes,
  ) {}
  @Get(':id/progress') @Header('Cache-Control', 'no-store') progressView(@Param('id') id: string) {
    return respond(() => this.progress.view(id))
  }
  @Get(':id/prize') @Header('Cache-Control', 'no-store') prizeView(@Param('id') id: string) {
    return respond(() => this.prizes.view(id))
  }
  @Roles(Role.Administrator)
  @Post('admin/:id/prize/configuration')
  @HttpCode(200)
  approve(
    @Param('id') id: string,
    @CurrentIdentity() actor: VerifiedIdentity,
    @Body() body: unknown,
  ) {
    return respond(() => this.prizes.approve(id, actor.subject, body))
  }
  @Roles(Role.Administrator)
  @Post('admin/:id/prize/deliver')
  @HttpCode(200)
  deliver(
    @Param('id') id: string,
    @CurrentIdentity() actor: VerifiedIdentity,
    @Body() body: unknown,
  ) {
    if (
      body === null ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 0
    )
      throw new HttpException(
        {
          code: 'INVALID_COMMAND',
          message: 'El campeón y los destinatarios se obtienen del torneo.',
        },
        400,
      )
    return respond(() => this.prizes.deliver(id, actor.subject))
  }
}
