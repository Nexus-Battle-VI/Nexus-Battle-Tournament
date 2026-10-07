import { Module, type CanActivate } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import type { Kysely } from 'kysely'

import { HealthController } from '../../adapters/inbound/http/health.controller'
import { READINESS_CHECKS, VERSION_REPORT } from '../../adapters/inbound/http/tokens.health'
import { TournamentMatchesController } from '../../adapters/inbound/http/tournament-matches.controller'
import {
  GET_TOURNAMENT_MATCH_DETAIL,
  LIST_TOURNAMENT_MATCHES,
} from '../../adapters/inbound/http/tokens.tournament-matches'
import { AnonymousIdentityGuard } from '../../adapters/inbound/http/auth/anonymous.guard'
import { InternalServiceGuard } from '../../adapters/inbound/http/auth/internal-service.guard'
import { JwtAuthGuard } from '../../adapters/inbound/http/auth/jwt-auth.guard'
import { RolesGuard } from '../../adapters/inbound/http/auth/roles.guard'
import { CognitoTokenVerifier } from '../../adapters/outbound/identity/CognitoTokenVerifier'
import type { Database } from '../../adapters/outbound/persistence/schema'
import { InMemoryTournamentEncounterRepository } from '../../adapters/outbound/persistence/InMemoryTournamentEncounterRepository'
import { PostgresTournamentEncounterRepository } from '../../adapters/outbound/persistence/PostgresTournamentEncounterRepository'
import { PersistedBracketEncounterSource } from '../../adapters/outbound/bracket/PersistedBracketEncounterSource'
import { HttpCombatRecordAdapter } from '../../adapters/outbound/combat/HttpCombatRecordAdapter'
import { RegistrationsController } from '../../adapters/inbound/http/registrations.controller'
import { BracketsController } from '../../adapters/inbound/http/brackets.controller'
import { EncounterAdminController } from '../../adapters/inbound/http/encounter-admin.controller'
import {
  ENCOUNTER_ADMINISTRATION,
  EncounterAdministration,
} from '../../application/use-cases/EncounterAdministration'
import {
  COMBAT_ROOM_COMMANDS,
  type CombatRoomCommandPort,
} from '../../application/ports/CombatRoomCommandPort'
import {
  ENCOUNTER_ADMIN_STORE,
  type EncounterAdminStore,
} from '../../application/ports/EncounterAdminPorts'
import { HttpCombatRoomCommandAdapter } from '../../adapters/outbound/combat/HttpCombatRoomCommandAdapter'
import { InMemoryEncounterAdminStore } from '../../adapters/outbound/persistence/InMemoryEncounterAdminStore'
import { PostgresEncounterAdminStore } from '../../adapters/outbound/persistence/PostgresEncounterAdminStore'
import { Registrations, REGISTRATIONS } from '../../application/use-cases/Registrations'
import { Brackets, BRACKETS } from '../../application/use-cases/Brackets'
import { RegistrationServices } from '../../adapters/outbound/http/RegistrationServices'
import { SimulatedEntryGateway } from '../../adapters/outbound/payment/SimulatedEntryGateway'
import { InMemoryRegistrationRepository } from '../../adapters/outbound/persistence/InMemoryRegistrationRepository'
import { PostgresRegistrationRepository } from '../../adapters/outbound/persistence/PostgresRegistrationRepository'
import { RegistrationReconciler } from '../scheduling/registration-reconciler'
import { CombatRecordReconciler } from '../scheduling/combat-record-reconciler'
import { SystemClock } from '../../adapters/outbound/system/SystemClock'
import { CLOCK, type ClockPort } from '../../application/ports/ClockPort'
import { TOKEN_VERIFIER, type TokenVerifierPort } from '../../application/ports/TokenVerifierPort'
import {
  TOURNAMENT_ENCOUNTER_REPOSITORY,
  type TournamentEncounterRepositoryPort,
} from '../../application/ports/TournamentEncounterRepositoryPort'
import {
  TOURNAMENT_ENCOUNTER_SOURCE,
  type TournamentEncounterSourcePort,
} from '../../application/ports/TournamentEncounterSourcePort'
import { COMBAT_RECORD, type CombatRecordPort } from '../../application/ports/CombatRecordPort'
import { GetTournamentMatchDetail } from '../../application/use-cases/GetTournamentMatchDetail'
import { ListTournamentMatches } from '../../application/use-cases/ListTournamentMatches'
import { AuthMode, loadConfig, PersistenceDriver, type AppConfig } from '../config/env'
import type { ReadinessCheck, VersionReport } from '../health/health'
import { describeError } from '../observability/describe-error'
import { createLogger, type Logger } from '../observability/logger'
import { createDatabase, pingDatabase } from '../persistence/database'
import { PROGRESSIONS, Progressions } from '../../application/use-cases/Progressions'
import { PRIZES, Prizes } from '../../application/use-cases/Prizes'
import {
  LIFECYCLE_REPOSITORY,
  PRIZE_DESTINATION,
  type LifecycleRepository,
  type TournamentPrizeDestination,
} from '../../application/ports/LifecyclePorts'
import { ArchivedTournamentMatchReadAdapter } from '../../adapters/outbound/combat/ArchivedTournamentMatchReadAdapter'
import { InMemoryLifecycleRepository } from '../../adapters/outbound/persistence/InMemoryLifecycleRepository'
import { PostgresLifecycleRepository } from '../../adapters/outbound/persistence/PostgresLifecycleRepository'
import { TournamentPrizeClient } from '../../adapters/outbound/http/TournamentPrizeClient'
import { ResultsPrizesController } from '../../adapters/inbound/http/results-prizes.controller'
import { LifecycleReconciler } from '../scheduling/lifecycle-reconciler'

export const APP_CONFIG = Symbol('AppConfig')
export const LOGGER = Symbol('Logger')
export const DATABASE = Symbol('Database')
export const DATABASE_LIFECYCLE = Symbol('DatabaseLifecycle')

/**
 * Servicios autorizados a llamar a las rutas `@InternalOnly()` de Tournament.
 *
 * Es la lista de consumidores que ADR-022 declara. Anadir uno es una decision
 * de arquitectura, no un ajuste de configuracion: por eso vive en codigo, donde
 * cambiarla exige un Pull Request revisado.
 */
export const INTERNAL_CALLERS: readonly string[] = []

/**
 * Raiz de composicion.
 *
 * Es el unico lugar donde se eligen implementaciones concretas. Los casos de
 * uso son clases planas sin decoradores de NestJS: se registran aqui con
 * fabricas explicitas, de modo que la capa de aplicacion permanece
 * independiente del framework.
 */
@Module({
  controllers: [
    HealthController,
    TournamentMatchesController,
    RegistrationsController,
    BracketsController,
    EncounterAdminController,
    ResultsPrizesController,
  ],
  providers: [
    {
      provide: LIFECYCLE_REPOSITORY,
      useFactory: (db: Kysely<Database> | null): LifecycleRepository =>
        db === null ? new InMemoryLifecycleRepository() : new PostgresLifecycleRepository(db),
      inject: [DATABASE],
    },
    {
      provide: PROGRESSIONS,
      useFactory: (
        store: LifecycleRepository,
        r: Registrations,
        encounters: TournamentEncounterRepositoryPort,
        combat: CombatRecordPort,
        clock: ClockPort,
      ) =>
        new Progressions(
          store,
          r.repository,
          new ArchivedTournamentMatchReadAdapter(encounters, combat),
          clock,
          encounters,
        ),
      inject: [
        LIFECYCLE_REPOSITORY,
        REGISTRATIONS,
        TOURNAMENT_ENCOUNTER_REPOSITORY,
        COMBAT_RECORD,
        CLOCK,
      ],
    },
    {
      provide: PRIZE_DESTINATION,
      useFactory: (config: AppConfig): TournamentPrizeDestination =>
        new TournamentPrizeClient(
          process.env.WALLET_BASE_URL,
          process.env.INVENTORY_BASE_URL,
          config.internalServiceAuthSecret,
        ),
      inject: [APP_CONFIG],
    },
    {
      provide: PRIZES,
      useFactory: (
        store: LifecycleRepository,
        r: Registrations,
        destination: TournamentPrizeDestination,
        clock: ClockPort,
      ) => new Prizes(store, r.repository, destination, clock),
      inject: [LIFECYCLE_REPOSITORY, REGISTRATIONS, PRIZE_DESTINATION, CLOCK],
    },
    {
      provide: LifecycleReconciler,
      useFactory: (progress: Progressions, prizes: Prizes) =>
        new LifecycleReconciler(progress, prizes),
      inject: [PROGRESSIONS, PRIZES],
    },
    {
      provide: REGISTRATIONS,
      useFactory: (
        db: Kysely<Database> | null,
        config: AppConfig,
        clock: ClockPort,
        encounters: TournamentEncounterRepositoryPort,
      ) => {
        const services = new RegistrationServices(
          process.env.ACCOUNT_BASE_URL,
          process.env.WALLET_BASE_URL,
          config.internalServiceAuthSecret,
        )
        return new Registrations(
          db === null
            ? new InMemoryRegistrationRepository(encounters)
            : new PostgresRegistrationRepository(db),
          services,
          services,
          clock,
          new SimulatedEntryGateway(),
        )
      },
      inject: [DATABASE, APP_CONFIG, CLOCK, TOURNAMENT_ENCOUNTER_REPOSITORY],
    },
    {
      provide: BRACKETS,
      useFactory: (r: Registrations, clock: ClockPort) => new Brackets(r.repository, clock),
      inject: [REGISTRATIONS, CLOCK],
    },
    {
      provide: RegistrationReconciler,
      useFactory: (r: Registrations) => new RegistrationReconciler(r),
      inject: [REGISTRATIONS],
    },
    {
      provide: CombatRecordReconciler,
      useFactory: (repository: TournamentEncounterRepositoryPort, combat: CombatRecordPort) =>
        new CombatRecordReconciler(repository, combat),
      inject: [TOURNAMENT_ENCOUNTER_REPOSITORY, COMBAT_RECORD],
    },
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => loadConfig(process.env),
    },
    {
      provide: LOGGER,
      useFactory: (config: AppConfig): Logger =>
        createLogger({
          level: config.logLevel,
          service: config.serviceName,
          version: config.version,
        }),
      inject: [APP_CONFIG],
    },
    {
      provide: CLOCK,
      useFactory: (): ClockPort => new SystemClock(),
    },
    {
      provide: DATABASE,
      useFactory: (config: AppConfig, logger: Logger): Kysely<Database> | null => {
        if (config.persistenceDriver !== PersistenceDriver.Postgres) {
          logger.warn('in_memory_persistence', {
            detail: 'PERSISTENCE_DRIVER=memory: el estado se pierde al reiniciar el servicio.',
          })

          return null
        }

        // `loadConfig` ya garantiza que DATABASE_URL existe con este driver.
        if (config.databaseUrl === null) {
          throw new Error('DATABASE_URL es obligatorio con PERSISTENCE_DRIVER=postgres.')
        }

        // El esquema NO se migra aqui: es un paso explicito, `npm run migrate`.
        return createDatabase({
          connectionString: config.databaseUrl,
          onIdleError: (error) => {
            logger.warn('postgres_idle_connection_error', { detail: describeError(error) })
          },
        })
      },
      inject: [APP_CONFIG, LOGGER],
    },
    {
      provide: DATABASE_LIFECYCLE,
      useFactory: (db: Kysely<Database> | null): { onModuleDestroy: () => Promise<void> } => ({
        onModuleDestroy: async (): Promise<void> => {
          await db?.destroy()
        },
      }),
      inject: [DATABASE],
    },
    {
      provide: TOKEN_VERIFIER,
      useFactory: (config: AppConfig, logger: Logger): TokenVerifierPort => {
        if (config.cognito === null) {
          // No se devuelve un verificador que acepte cualquier cosa: con
          // AUTH_MODE=disabled el guard que lo usaria no se registra.
          logger.warn('authentication_disabled', {
            detail: 'AUTH_MODE=disabled: ninguna ruta verifica quien realiza la peticion.',
          })

          return {
            verify: (): Promise<never> =>
              Promise.reject(new Error('No hay verificador de testimonios configurado.')),
          }
        }

        return new CognitoTokenVerifier(config.cognito)
      },
      inject: [APP_CONFIG, LOGGER],
    },
    // El orden importa: NestJS ejecuta los guards globales en el orden en que se
    // declaran. Primero la identidad, despues los roles, despues el contrato
    // interno, que solo actua sobre rutas `@InternalOnly()`.
    {
      provide: APP_GUARD,
      useFactory: (
        config: AppConfig,
        reflector: Reflector,
        verifier: TokenVerifierPort,
      ): CanActivate =>
        config.authMode === AuthMode.Jwt
          ? new JwtAuthGuard(reflector, verifier)
          : new AnonymousIdentityGuard(),
      inject: [APP_CONFIG, Reflector, TOKEN_VERIFIER],
    },
    {
      provide: APP_GUARD,
      useFactory: (config: AppConfig, reflector: Reflector): CanActivate =>
        config.authMode === AuthMode.Jwt
          ? new RolesGuard(reflector)
          : { canActivate: (): boolean => true },
      inject: [APP_CONFIG, Reflector],
    },
    {
      provide: APP_GUARD,
      useFactory: (
        config: AppConfig,
        reflector: Reflector,
        clock: ClockPort,
        logger: Logger,
      ): CanActivate =>
        new InternalServiceGuard({
          reflector,
          secret: config.internalServiceAuthSecret,
          allowedServices: INTERNAL_CALLERS,
          clock,
          logger,
        }),
      inject: [APP_CONFIG, Reflector, CLOCK, LOGGER],
    },
    {
      provide: READINESS_CHECKS,
      useFactory: (db: Kysely<Database> | null): readonly ReadinessCheck[] =>
        // Con PostgreSQL la sonda va hasta el motor. En memoria no hay
        // dependencia externa que comprobar, y no se inventa una.
        db === null ? [] : [{ name: 'postgres', check: () => pingDatabase(db) }],
      inject: [DATABASE],
    },
    {
      provide: VERSION_REPORT,
      useFactory: (config: AppConfig): VersionReport => ({
        service: config.serviceName,
        version: config.version,
        nodeEnv: config.nodeEnv,
      }),
      inject: [APP_CONFIG],
    },
    // --- HU-83 (Management#465): registro y consulta de justas -------------
    //
    // Fuente persistida HU-78 y lectura HTTP de salas de Combat previamente
    // vinculadas. Los fixtures históricos solo se seleccionan en pruebas;
    // crear o iniciar salas sigue perteneciendo al incremento HU-85.
    {
      provide: TOURNAMENT_ENCOUNTER_REPOSITORY,
      useFactory: (db: Kysely<Database> | null): TournamentEncounterRepositoryPort =>
        db === null
          ? new InMemoryTournamentEncounterRepository()
          : new PostgresTournamentEncounterRepository(db),
      inject: [DATABASE],
    },
    {
      provide: TOURNAMENT_ENCOUNTER_SOURCE,
      useFactory: (r: Registrations): TournamentEncounterSourcePort =>
        new PersistedBracketEncounterSource(r.repository),
      inject: [REGISTRATIONS],
    },
    {
      provide: COMBAT_RECORD,
      useFactory: (config: AppConfig): CombatRecordPort =>
        new HttpCombatRecordAdapter(process.env.COMBAT_BASE_URL, config.internalServiceAuthSecret),
      inject: [APP_CONFIG],
    },
    // --- HU-85 (Management#470): preparar e iniciar justas -----------------
    {
      provide: COMBAT_ROOM_COMMANDS,
      useFactory: (config: AppConfig): CombatRoomCommandPort =>
        new HttpCombatRoomCommandAdapter(
          process.env.COMBAT_BASE_URL,
          config.internalServiceAuthSecret,
        ),
      inject: [APP_CONFIG],
    },
    {
      provide: ENCOUNTER_ADMIN_STORE,
      useFactory: (db: Kysely<Database> | null): EncounterAdminStore =>
        db === null ? new InMemoryEncounterAdminStore() : new PostgresEncounterAdminStore(db),
      inject: [DATABASE],
    },
    {
      provide: ENCOUNTER_ADMINISTRATION,
      useFactory: (
        repository: TournamentEncounterRepositoryPort,
        source: TournamentEncounterSourcePort,
        combat: CombatRecordPort,
        commands: CombatRoomCommandPort,
        store: EncounterAdminStore,
        clock: ClockPort,
        brackets: Brackets,
      ): EncounterAdministration =>
        new EncounterAdministration(repository, source, combat, commands, store, clock, (id) =>
          brackets.view(id),
        ),
      inject: [
        TOURNAMENT_ENCOUNTER_REPOSITORY,
        TOURNAMENT_ENCOUNTER_SOURCE,
        COMBAT_RECORD,
        COMBAT_ROOM_COMMANDS,
        ENCOUNTER_ADMIN_STORE,
        CLOCK,
        BRACKETS,
      ],
    },
    {
      provide: LIST_TOURNAMENT_MATCHES,
      useFactory: (
        repository: TournamentEncounterRepositoryPort,
        source: TournamentEncounterSourcePort,
        combat: CombatRecordPort,
      ): ListTournamentMatches => new ListTournamentMatches(repository, source, combat),
      inject: [TOURNAMENT_ENCOUNTER_REPOSITORY, TOURNAMENT_ENCOUNTER_SOURCE, COMBAT_RECORD],
    },
    {
      provide: GET_TOURNAMENT_MATCH_DETAIL,
      useFactory: (
        repository: TournamentEncounterRepositoryPort,
        source: TournamentEncounterSourcePort,
        combat: CombatRecordPort,
      ): GetTournamentMatchDetail => new GetTournamentMatchDetail(repository, source, combat),
      inject: [TOURNAMENT_ENCOUNTER_REPOSITORY, TOURNAMENT_ENCOUNTER_SOURCE, COMBAT_RECORD],
    },
  ],
})
export class AppModule {}
