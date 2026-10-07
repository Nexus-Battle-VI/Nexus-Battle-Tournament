import { InMemoryTournamentEncounterRepository } from '../../src/adapters/outbound/persistence/InMemoryTournamentEncounterRepository'
import 'reflect-metadata'
import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'
import { REGISTRATIONS } from '../../src/application/use-cases/Registrations'
import { InMemoryRegistrationRepository } from '../../src/adapters/outbound/persistence/InMemoryRegistrationRepository'
import { CLOCK } from '../../src/application/ports/ClockPort'
import {
  TOKEN_VERIFIER,
  Role,
  TokenVerificationError,
} from '../../src/application/ports/TokenVerifierPort'
import { bracketClock, registrationService, tournamentFixture } from '../support/bracket-fixture'

const channel = 'https://www.youtube.com/channel/UCscW71t4iP--b-7HFDPFosA'
const live = 'https://www.youtube.com/watch?v=abcdefghijk'
describe('HU-82 HTTP: identidad, permisos, validación y enlaces públicos', () => {
  let app: INestApplication, previous: NodeJS.ProcessEnv
  beforeAll(async () => {
    previous = { ...process.env }
    Object.assign(process.env, {
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_test',
      COGNITO_CLIENT_ID: 'test',
      PERSISTENCE_DRIVER: 'memory',
      ENCOUNTER_RECONCILE_INTERVAL_MS: '0',
      PRIZE_RECONCILE_INTERVAL_MS: '0',
    })
    const tournaments = new InMemoryRegistrationRepository(
      new InMemoryTournamentEncounterRepository(),
    )
    await tournaments.create(tournamentFixture(), 'create-T1', 'T1')
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRATIONS)
      .useValue(registrationService(tournaments))
      .overrideProvider(CLOCK)
      .useValue(bracketClock)
      .overrideProvider(TOKEN_VERIFIER)
      .useValue({
        verify: (token: string) =>
          token === 'invalid'
            ? Promise.reject(new TokenVerificationError())
            : Promise.resolve({
                subject: token,
                email: null,
                roles: new Set([
                  token === 'player'
                    ? Role.Player
                    : token === 'super'
                      ? Role.SuperAdministrator
                      : Role.Administrator,
                ]),
              }),
      })
      .compile()
    app = module.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    )
    await app.init()
  })
  afterAll(async () => {
    await app.close()
    process.env = previous
  })
  const get = (token: string, id = 'T1') =>
    request(app.getHttpServer())
      .get(`/api/v1/tournaments/${id}/links`)
      .set('authorization', `Bearer ${token}`)
  const save = (token: string, body: object) =>
    request(app.getHttpServer())
      .put('/api/v1/tournaments/admin/T1/links')
      .set('authorization', `Bearer ${token}`)
      .send(body)
  const command = { liveUrl: live, youtubeArchiveUrl: channel, expectedRevision: 0 }
  it('requiere sesión, permite consulta al jugador y reserva la edición al administrador', async () => {
    expect((await request(app.getHttpServer()).get('/api/v1/tournaments/T1/links')).status).toBe(
      401,
    )
    expect((await get('invalid')).status).toBe(401)
    expect((await get('player')).body.liveUrl).toBeNull()
    expect((await save('player', command)).status).toBe(403)
    expect((await get('player')).body.revision).toBe(0)
    expect((await get('admin', 'unknown')).status).toBe(404)
    expect((await save('admin', command)).status).toBe(200)
    expect((await get('player')).headers['cache-control']).toBe('no-store')
    expect((await get('player')).body).toMatchObject({
      liveUrl: live,
      youtubeArchiveUrl: channel,
      revision: 1,
    })
  })
  it('rechaza secretos, campos ajenos, ausencia y tipos incorrectos; preserva datos', async () => {
    for (const body of [
      { ...command, actor: 'admin' },
      { ...command, streamKey: 'do-not-store' },
      { liveUrl: live, expectedRevision: 1 },
      { youtubeArchiveUrl: channel, expectedRevision: 1 },
      { ...command, expectedRevision: null },
      { ...command, expectedRevision: -1 },
      { ...command, liveUrl: 123 },
      { ...command, youtubeArchiveUrl: undefined },
    ])
      expect((await save('admin', body)).status).toBe(400)
    for (const body of [
      { ...command, liveUrl: 'javascript:alert(1)', expectedRevision: 1 },
      { ...command, youtubeArchiveUrl: 'https://twitch.tv/nexus', expectedRevision: 1 },
      { ...command, liveUrl: `${live}&token=secret`, expectedRevision: 1 },
    ]) {
      const response = await save('admin', body)
      expect(response.status).toBe(422)
      expect(response.body.code).toBe('LINKS_INVALID')
      expect(response.body.message).toBeTruthy()
    }
    expect((await get('player')).body).toMatchObject({
      liveUrl: live,
      youtubeArchiveUrl: channel,
      revision: 1,
    })
    expect((await save('admin', command)).body.revision).toBe(1)
    expect((await save('admin', { ...command, liveUrl: 'https://twitch.tv/nexus' })).status).toBe(
      409,
    )
  })
  it('superadministrador corrige el archivo, retira el directo y no publica estado de emisión', async () => {
    const response = await save('super', {
      liveUrl: null,
      youtubeArchiveUrl: `${channel}/streams`,
      expectedRevision: 1,
    })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      tournamentId: 'T1',
      liveUrl: null,
      youtubeArchiveUrl: `${channel}/streams`,
      revision: 2,
      updatedAt: bracketClock.now().toISOString(),
    })
    expect((await get('player')).body).toEqual(response.body)
  })
})
