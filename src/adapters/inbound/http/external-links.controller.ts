import { Body, Controller, Get, Header, HttpException, Inject, Param, Put } from '@nestjs/common'
import { IsInt, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator'
import { EXTERNAL_LINKS, ExternalLinks } from '../../../application/use-cases/ExternalLinks'
import { Role } from '../../../application/ports/TokenVerifierPort'
import { RegistrationError } from '../../../domain/registration'
import { Roles } from './auth/decorators'
class LinksCommand {
  @ValidateIf((_o, value: unknown) => value !== null) @IsString() @MaxLength(2048) liveUrl!:
    string | null
  @ValidateIf((_o, value: unknown) => value !== null)
  @IsString()
  @MaxLength(2048)
  youtubeArchiveUrl!: string | null
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
@Controller('v1/tournaments')
export class ExternalLinksController {
  constructor(@Inject(EXTERNAL_LINKS) private readonly links: ExternalLinks) {}
  @Get(':id/links')
  @Header('Cache-Control', 'no-store')
  view(@Param('id') id: string) {
    return respond(() => this.links.view(id))
  }
  @Put('admin/:id/links')
  @Roles(Role.Administrator)
  @Header('Cache-Control', 'no-store')
  save(@Param('id') id: string, @Body() body: LinksCommand) {
    return respond(() => this.links.save(id, body))
  }
}
