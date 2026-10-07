import 'reflect-metadata'
import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'
import { REGISTRATIONS } from '../../src/application/use-cases/Registrations'
import { BROADCASTS } from '../../src/application/use-cases/Broadcasts'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
} from '../../src/application/ports/TokenVerifierPort'
import { broadcastFixture } from '../support/broadcast-fixture'

describe('HU-79/81 HTTP: JWT, transmisor por torneo, selección y datos visibles', () => {
  let app: INestApplication,
    f: Awaited<ReturnType<typeof broadcastFixture>>,
    previous: NodeJS.ProcessEnv
  beforeAll(async () => {
    previous = { ...process.env }
    Object.assign(process.env, {
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_fixture',
      COGNITO_CLIENT_ID: 'fixture',
      PERSISTENCE_DRIVER: 'memory',
      PROGRESS_RECONCILE_INTERVAL_MS: '0',
      PRIZE_RECONCILE_INTERVAL_MS: '0',
    })
    f = await broadcastFixture()
    const m = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRATIONS)
      .useValue(f.registrations)
      .overrideProvider(BROADCASTS)
      .useValue(f.service)
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
    app = m.createNestApplication()
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
  const post = (path: string, token: string, body: object) =>
    request(app.getHttpServer())
      .post('/api/v1/tournaments/' + path)
      .set('authorization', 'Bearer ' + token)
      .send(body)
  const get = (path: string, token: string) =>
    request(app.getHttpServer())
      .get('/api/v1/tournaments/' + path)
      .set('authorization', 'Bearer ' + token)
  it('401/403 y transmisor único; admin no designado no accede a captura', async () => {
    expect(
      (await request(app.getHttpServer()).get(`/api/v1/tournaments/${f.id}/broadcast/view`)).status,
    ).toBe(401)
    expect((await get(`${f.id}/broadcast/view`, 'invalid')).status).toBe(401)
    expect((await post(`admin/${f.id}/broadcast/designate`, 'player', {})).status).toBe(403)
    expect((await post(`admin/${f.id}/broadcast/designate`, 'A', {})).body).toMatchObject({
      broadcasterId: 'A',
      revision: 1,
    })
    expect((await post(`admin/${f.id}/broadcast/designate`, 'B', {})).status).toBe(409)
    expect((await get(`${f.id}/broadcast/view`, 'B')).status).toBe(403)
  })
  it('rechaza identidad/campos/tipos ajenos y conserva revisión; admite id opaco completo', async () => {
    for (const command of [
      { expectedRevision: null },
      { actor: 'other' },
      { broadcasterId: 'other' },
    ])
      expect((await post(`admin/${f.id}/broadcast/designate`, 'A', command)).status).toBe(400)
    for (const command of [
      { matchId: f.e1.encounterId },
      { matchId: f.e1.encounterId, expectedRevision: 1, actor: 'other' },
      { matchId: f.e1.encounterId, expectedRevision: 0.5 },
      { matchId: 1, expectedRevision: 1 },
    ])
      expect((await post(`${f.id}/broadcast/selection`, 'A', command)).status).toBe(400)
    const selected = await post(`${f.id}/broadcast/selection`, 'A', {
      matchId: f.e1.encounterId,
      expectedRevision: 1,
    })
    expect(selected.status).toBe(200)
    expect(selected.body.snapshot.matchId).toBe(f.e1.encounterId)
    expect(selected.body.snapshot.bracketLabel).toBe('E1')
    expect(JSON.stringify(selected.body)).not.toMatch(/must-not-be-exposed|token|private-action/u)
    expect((await get(`${f.id}/broadcast/view`, 'A')).headers['cache-control']).toBe('no-store')
    expect(
      (await post(`${f.id}/broadcast/selection`, 'A', { matchId: 'E1', expectedRevision: 2 }))
        .status,
    ).toBe(404)
    expect(
      (
        await post(`${f.id}/broadcast/selection`, 'A', {
          matchId: f.e2.encounterId,
          expectedRevision: 1,
        })
      ).status,
    ).toBe(409)
  })
  it('cambia E1/E2, sustituye transmisor y no expone controles de Combat', async () => {
    const changed = await post(`${f.id}/broadcast/selection`, 'A', {
      matchId: f.e2.encounterId,
      expectedRevision: 2,
    })
    expect(changed.status).toBe(200)
    expect(changed.body.snapshot.matchId).toBe(f.e2.encounterId)
    expect((await get(`${f.id}/broadcast/active`, 'A')).body.matches).toHaveLength(2)
    expect(
      (await post(`admin/${f.id}/broadcast/designate`, 'super', { expectedRevision: 3 })).status,
    ).toBe(200)
    expect((await get(`${f.id}/broadcast/view`, 'A')).status).toBe(403)
    expect((await get(`${f.id}/broadcast/view`, 'super')).body.snapshot.matchId).toBe(
      f.e2.encounterId,
    )
    expect((await post(`${f.id}/broadcast/attack`, 'super', { target: 'foreign' })).status).toBe(
      404,
    )
    expect(f.source.items.size).toBe(2)
  })
})
