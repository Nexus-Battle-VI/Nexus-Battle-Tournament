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
import { IsInt, ValidateIf, IsString, MaxLength, Min, Max } from 'class-validator'
import { BROADCASTS, Broadcasts } from '../../../application/use-cases/Broadcasts'
import { Role, type VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import { RegistrationError } from '../../../domain/registration'
import { CurrentIdentity, Roles } from './auth/decorators'
class DesignationCommand {
  @ValidateIf((_o, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER - 1)
  expectedRevision?: number
}
class SelectionCommand {
  @IsString() @MaxLength(512) matchId!: string
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER - 1) expectedRevision!: number
}
const respond = async <T>(action: () => Promise<T>): Promise<T> => {
  try {
    return await action()
  } catch (error: unknown) {
    if (error instanceof RegistrationError)
      throw new HttpException({ code: error.code, message: error.message }, error.status)
    throw error
  }
}
@Roles(Role.Administrator)
@Controller('v1/tournaments')
export class BroadcastsController {
  constructor(@Inject(BROADCASTS) private readonly broadcasts: Broadcasts) {}
  @Get('admin/:id/broadcast')
  @Header('Cache-Control', 'no-store')
  configuration(@Param('id') id: string) {
    return respond(() => this.broadcasts.configuration(id))
  }
  @Post('admin/:id/broadcast/designate')
  @HttpCode(200)
  designate(
    @Param('id') id: string,
    @CurrentIdentity() actor: VerifiedIdentity,
    @Body() body: DesignationCommand,
  ) {
    return respond(() => this.broadcasts.designate(id, actor.subject, body.expectedRevision))
  }
  @Get(':id/broadcast/active')
  @Header('Cache-Control', 'no-store')
  active(@Param('id') id: string, @CurrentIdentity() actor: VerifiedIdentity) {
    return respond(() => this.broadcasts.active(id, actor.subject))
  }
  @Get(':id/broadcast/view')
  @Header('Cache-Control', 'no-store')
  observe(@Param('id') id: string, @CurrentIdentity() actor: VerifiedIdentity) {
    return respond(() => this.broadcasts.observe(id, actor.subject))
  }
  @Post(':id/broadcast/selection')
  @HttpCode(200)
  select(
    @Param('id') id: string,
    @CurrentIdentity() actor: VerifiedIdentity,
    @Body() body: SelectionCommand,
  ) {
    return respond(() =>
      this.broadcasts.select(id, body.matchId, actor.subject, body.expectedRevision),
    )
  }
}
