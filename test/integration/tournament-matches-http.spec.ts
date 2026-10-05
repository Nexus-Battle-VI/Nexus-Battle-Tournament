import 'reflect-metadata'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'

/**
 * Pruebas HTTP de HU-83 (Management#465): las dos rutas de consulta de
 * justas, con autenticacion JWT activa y persistencia en memoria (los
 * adaptadores de fuente de bracket/Combat son los dobles de desarrollo
 * reales que se registran en `AppModule`, no sustitutos de prueba: es
 * exactamente lo que corre hoy en desarrollo).
 */
const IDENTITY: VerifiedIdentity = {
  subject: 'participante-1',
  email: null,
  roles: new Set([Role.Player]),
}

const stubVerifier: TokenVerifierPort = {
  verify: (token: string): Promise<VerifiedIdentity> =>
    token === 'token-valido'
      ? Promise.resolve(IDENTITY)
      : Promise.reject(new TokenVerificationError()),
}

const withEnv = (values: Record<string, string>): (() => void) => {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  Object.assign(process.env, values)

  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key)
      } else {
        process.env[key] = value
      }
    }
  }
}

describe('GET /api/v1/tournaments/:tournamentId/matches (HU-83)', () => {
  let app: INestApplication
  let restore: () => void

  beforeAll(async () => {
    restore = withEnv({
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-de-pruebas',
      PERSISTENCE_DRIVER: 'memory',
    })

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(stubVerifier)
      .compile()

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    )
    await app.init()
  })

  afterAll(async () => {
    await app.close()
    restore()
  })

  const auth = (req: request.Test) => req.set('Authorization', 'Bearer token-valido')

  it('exige testimonio de identidad (401 sin token)', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/tournaments/T1/matches')

    expect(response.status).toBe(401)
  })

  it('lista las justas de un torneo con su estado (CA-02)', async () => {
    const response = await auth(request(app.getHttpServer()).get('/api/v1/tournaments/T1/matches'))

    expect(response.status).toBe(200)
    expect(response.body).toHaveLength(4)

    const byLabel = Object.fromEntries(
      (response.body as { bracketLabel: string; status: string }[]).map((m) => [m.bracketLabel, m]),
    )

    expect(byLabel.E1!.status).toBe('READY')
    expect(byLabel.E2!.status).toBe('IN_PROGRESS')
    expect(byLabel.E3!.status).toBe('FINISHED')
    expect(byLabel.E4!.status).toBe('WAITING_PARTICIPANTS')
  })

  /**
   * El fixture de desarrollo (`DevFixtureTournamentEncounterSource`) solo
   * fabrica justas para una lista fija de `tournamentId` conocidos; un id
   * inventado se trata como "torneo sin justas todavia", no como un torneo
   * valido con datos fabricados.
   */
  it('lista vacia para un tournamentId que el fixture de desarrollo no reconoce', async () => {
    const response = await auth(
      request(app.getHttpServer()).get('/api/v1/tournaments/torneo-inventado/matches'),
    )

    expect(response.status).toBe(200)
    expect(response.body).toEqual([])
  })

  it('dos torneos simultaneos no mezclan sus justas (CA-01)', async () => {
    const t1 = await auth(request(app.getHttpServer()).get('/api/v1/tournaments/T-ca01-a/matches'))
    const t2 = await auth(request(app.getHttpServer()).get('/api/v1/tournaments/T-ca01-b/matches'))

    expect(t1.status).toBe(200)
    expect(t2.status).toBe(200)

    const t1Ids = (t1.body as { tournamentId: string }[]).map((m) => m.tournamentId)
    const t2Ids = (t2.body as { tournamentId: string }[]).map((m) => m.tournamentId)

    expect(t1Ids.every((id) => id === 'T-ca01-a')).toBe(true)
    expect(t2Ids.every((id) => id === 'T-ca01-b')).toBe(true)
  })

  it('devuelve el detalle de una justa en curso sin ganador ni cierre (CA-04)', async () => {
    const response = await auth(
      request(app.getHttpServer()).get('/api/v1/tournaments/T-detail/matches/E2'),
    )

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      tournamentId: 'T-detail',
      matchId: 'E2',
      status: 'IN_PROGRESS',
      result: null,
      closedAt: null,
    })
    expect(response.body.events.length).toBeGreaterThan(0)
  })

  it('devuelve el detalle de una justa finalizada con resultado y evento de cierre', async () => {
    const response = await auth(
      request(app.getHttpServer()).get('/api/v1/tournaments/T-detail-2/matches/E3'),
    )

    expect(response.status).toBe(200)
    expect(response.body.status).toBe('FINISHED')
    expect(response.body.result.winnerTeamLabel).toBe('A')
    expect(response.body.closedAt).not.toBeNull()
  })

  it('pagina los eventos del detalle con afterSeq, nextSeq y hasMore', async () => {
    const server = app.getHttpServer()
    const first = await auth(
      request(server).get('/api/v1/tournaments/T-pagina/matches/E3?afterSeq=0'),
    )

    expect(first.status).toBe(200)
    expect(first.body.hasMore).toBe(false)
    expect(first.body.events).toHaveLength(5)

    const partial = await auth(
      request(server).get(
        `/api/v1/tournaments/T-pagina/matches/E3?afterSeq=${String(first.body.events[1].seq as number)}`,
      ),
    )

    expect(partial.status).toBe(200)
    expect((partial.body.events as { seq: number }[]).every((e) => e.seq > 2)).toBe(true)
  })

  it('rechaza un afterSeq invalido (400)', async () => {
    const response = await auth(
      request(app.getHttpServer()).get('/api/v1/tournaments/T1/matches/E1?afterSeq=-1'),
    )

    expect(response.status).toBe(400)
  })

  /** CA-06: identificador inexistente. */
  it('responde 404 para una justa inexistente, sin exponer ningun registro', async () => {
    const response = await auth(
      request(app.getHttpServer()).get('/api/v1/tournaments/T1/matches/E999'),
    )

    expect(response.status).toBe(404)
  })

  /**
   * CA-06: un `matchId` que SI existe, pero en un torneo HERMANO, con la
   * MISMA etiqueta de bracket ("E2" en T-cruzado-A y en T-cruzado-B). Pedir
   * un `matchId` inventado (como antes) es indistinguible de un simple "no
   * encontrado" y no detectaria una regresion que quitara el filtro por
   * `tournamentId` de la busqueda; esto si lo detectaria, porque E2 de
   * T-cruzado-B existe y podria "filtrarse" hacia T-cruzado-A.
   */
  it('nunca devuelve el registro de la justa homonima de otro torneo (CA-06)', async () => {
    const server = app.getHttpServer()
    // Siembra ambos torneos: los dos tienen su PROPIA E2.
    await auth(request(server).get('/api/v1/tournaments/T-cruzado-A/matches'))
    await auth(request(server).get('/api/v1/tournaments/T-cruzado-B/matches'))

    const fromA = await auth(request(server).get('/api/v1/tournaments/T-cruzado-A/matches/E2'))
    const fromB = await auth(request(server).get('/api/v1/tournaments/T-cruzado-B/matches/E2'))

    expect(fromA.status).toBe(200)
    expect(fromB.status).toBe(200)
    expect(fromA.body.tournamentId).toBe('T-cruzado-A')
    expect(fromB.body.tournamentId).toBe('T-cruzado-B')
  })

  it('consultar el detalle dos veces conserva el mismo resultado (CA-03, lectura no destructiva)', async () => {
    const server = app.getHttpServer()
    const first = await auth(request(server).get('/api/v1/tournaments/T-reconsulta/matches/E3'))
    const second = await auth(request(server).get('/api/v1/tournaments/T-reconsulta/matches/E3'))

    expect(first.body.result).toEqual(second.body.result)
    expect(first.body.closedAt).toEqual(second.body.closedAt)
  })
})
