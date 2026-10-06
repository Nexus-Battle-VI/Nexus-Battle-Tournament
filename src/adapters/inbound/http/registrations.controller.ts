import { Body, Controller, Get, HttpCode, HttpException, Inject, Param, Post } from '@nestjs/common'
import { Type } from 'class-transformer'
import {
  Allow,
  Equals,
  IsBoolean,
  IsDateString,
  IsDefined,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator'
import { REGISTRATIONS, Registrations } from '../../../application/use-cases/Registrations'
import { Role, type VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import { RegistrationError, publicTeam } from '../../../domain/registration'
import { CurrentIdentity, Roles } from './auth/decorators'
class OperationDto {
  @IsString() @MinLength(1) @MaxLength(100) operationId!: string
}
class AvatarDto {
  @Equals('ACCOUNT_AVATAR') kind!: 'ACCOUNT_AVATAR'
  @IsString() @MinLength(1) @MaxLength(200) subject!: string
}
class RegisterDto extends OperationDto {
  @IsString() @MinLength(1) @MaxLength(200) name!: string
  @IsDefined() @IsObject() @ValidateNested() @Type(() => AvatarDto) avatar!: AvatarDto
  @IsString() @MinLength(1) @MaxLength(200) companionId!: string
}
class ConsentDto extends OperationDto {
  @IsBoolean() accept!: boolean
}
class CardDto {
  @IsString() @MinLength(1) @MaxLength(200) holder!: string
  @IsString() @MinLength(1) @MaxLength(32) number!: string
  @IsString() @MinLength(1) @MaxLength(16) expiry!: string
  @IsString() @MinLength(1) @MaxLength(16) securityCode!: string
}
class EntryDto extends OperationDto {
  @ValidateIf((_: object, value: unknown) => value !== undefined)
  @IsIn(['CREDITS', 'SIMULATED_MONEY'])
  method?: 'CREDITS' | 'SIMULATED_MONEY'
  @ValidateIf((_: object, value: unknown) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => CardDto)
  card?: CardDto
}
class CreateDto extends OperationDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string
  @Allow() entryPolicy?: unknown
  @IsOptional() @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) entryFee?: number
  @IsDateString() opensAt!: string
  @IsDateString() closesAt!: string
  @IsDateString() startsAt!: string
}
@Controller('v1/tournaments')
export class RegistrationsController {
  constructor(@Inject(REGISTRATIONS) private readonly registrations: Registrations) {}
  private async respond<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action()
    } catch (error: unknown) {
      if (error instanceof RegistrationError)
        throw new HttpException({ code: error.code, message: error.message }, error.status)
      throw error
    }
  }
  private mutate(id: string, action: () => Promise<Parameters<typeof publicTeam>[1]>) {
    return this.respond(async () => publicTeam(id, await action()))
  }
  @Get()
  list() {
    return this.respond(() => this.registrations.list())
  }
  @Get(':id/registration')
  view(@Param('id') id: string, @CurrentIdentity() actor: VerifiedIdentity) {
    return this.respond(() => this.registrations.view(id, actor.subject))
  }
  @Roles(Role.Player)
  @Post(':id/teams')
  @HttpCode(200)
  register(
    @Param('id') id: string,
    @CurrentIdentity() actor: VerifiedIdentity,
    @Body() body: RegisterDto,
  ) {
    return this.mutate(id, () => this.registrations.register(id, actor.subject, body))
  }
  @Roles(Role.Player)
  @Post(':id/teams/:teamId/consent')
  @HttpCode(200)
  consent(
    @Param('id') id: string,
    @Param('teamId') teamId: string,
    @CurrentIdentity() actor: VerifiedIdentity,
    @Body() body: ConsentDto,
  ) {
    return this.mutate(id, () =>
      this.registrations.consent(id, teamId, actor.subject, body.operationId, body.accept),
    )
  }
  @Roles(Role.Player)
  @Post(':id/teams/:teamId/cancel')
  @HttpCode(200)
  cancel(
    @Param('id') id: string,
    @Param('teamId') teamId: string,
    @CurrentIdentity() actor: VerifiedIdentity,
    @Body() body: OperationDto,
  ) {
    return this.mutate(id, () =>
      this.registrations.cancel(id, teamId, actor.subject, body.operationId),
    )
  }
  @Roles(Role.Player)
  @Post(':id/teams/:teamId/entry')
  @HttpCode(200)
  enter(
    @Param('id') id: string,
    @Param('teamId') teamId: string,
    @CurrentIdentity() actor: VerifiedIdentity,
    @Body() body: EntryDto,
  ) {
    return this.mutate(id, () => this.registrations.enter(id, teamId, actor.subject, body))
  }
  @Roles(Role.Administrator)
  @Post('admin')
  @HttpCode(200)
  create(@CurrentIdentity() actor: VerifiedIdentity, @Body() body: CreateDto) {
    return this.respond(() => this.registrations.create(actor.subject, body))
  }
}
