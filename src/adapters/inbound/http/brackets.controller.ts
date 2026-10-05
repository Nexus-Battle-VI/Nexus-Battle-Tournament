import { Body, Controller, Get, HttpCode, HttpException, Inject, Param, Post } from '@nestjs/common'
import { IsString, MaxLength, MinLength } from 'class-validator'
import { BRACKETS, Brackets } from '../../../application/use-cases/Brackets'
import { Role, type VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import { RegistrationError } from '../../../domain/registration'
import { CurrentIdentity, Roles } from './auth/decorators'
class PublishBracketDto {
  @IsString() @MinLength(1) @MaxLength(100) operationId!: string
}
@Controller('v1/tournaments')
export class BracketsController {
  constructor(@Inject(BRACKETS) private readonly brackets: Brackets) {}
  private async respond<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action()
    } catch (error: unknown) {
      if (error instanceof RegistrationError)
        throw new HttpException({ code: error.code, message: error.message }, error.status)
      throw error
    }
  }
  @Get(':id/bracket')
  view(@Param('id') id: string) {
    return this.respond(async () => ({ bracket: await this.brackets.view(id) }))
  }
  @Roles(Role.Administrator)
  @Post('admin/:id/bracket')
  @HttpCode(200)
  publish(
    @Param('id') id: string,
    @CurrentIdentity() actor: VerifiedIdentity,
    @Body() body: PublishBracketDto,
  ) {
    return this.respond(() => this.brackets.publish(id, actor.subject, body.operationId))
  }
}
