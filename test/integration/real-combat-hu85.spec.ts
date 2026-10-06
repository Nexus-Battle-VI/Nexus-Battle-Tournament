import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { HttpCombatRecordAdapter } from '../../src/adapters/outbound/combat/HttpCombatRecordAdapter'
import { HttpCombatRoomCommandAdapter } from '../../src/adapters/outbound/combat/HttpCombatRoomCommandAdapter'
import { InMemoryEncounterAdminStore } from '../../src/adapters/outbound/persistence/InMemoryEncounterAdminStore'
import { PersistedBracketEncounterSource } from '../../src/adapters/outbound/bracket/PersistedBracketEncounterSource'
import { EncounterAdministration } from '../../src/application/use-cases/EncounterAdministration'
import { fixture, FREE_POLICY } from '../support/registration-fixture'

/**
 * HU-85.4 (Management#488): verificación contra el servicio Combat REAL.
 *
 * REAL: el proceso `node dist/main.js` de Nexus-Battle-Combat (sus rutas
 * internas de tournament-rooms, guard HMAC, validación de roster, motor de
 * StartBattle y persistencia en memoria de Combat) y los adaptadores HTTP
 * reales de Tournament (firma HMAC, 422/409/503).
 * DOBLES DE PRUEBA: Account y Player-Inventory (los dos servicios que Combat
 * consulta) son servidores locales mínimos de este archivo, que NO validan la
 * firma HMAC; Tournament usa repositorios en memoria. No prueba Cognito,
 * Wallet, Account ni Inventory reales ni PostgreSQL (eso lo cubren las
 * pruebas `test/db`).
 *
 * Se ejecuta solo con `HU85_REAL_COMBAT_DIR=<ruta a Nexus-Battle-Combat ya
 * compilada con npm run build>`; sin esa variable se omite y lo dice.
 */
const dir = process.env.HU85_REAL_COMBAT_DIR
const suite = dir === undefined ? describe.skip : describe
const SECRET = 'verificacion-hu85-secreto-local'
const heroTemplate = JSON.parse(
  readFileSync(join(__dirname, '../support/combat-equipped-hero.json'), 'utf8'),
) as Record<string, unknown>

const uuidOf = (text: string): string => {
  const hex = createHash('sha256').update(text).digest('hex')
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`
}

const listen = (server: Server): Promise<number> =>
  new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      done((server.address() as AddressInfo).port)
    })
  })
const json = (status: number, body: unknown): { status: number; body: string } => ({
  status,
  body: JSON.stringify(body),
})

suite('HU-85.4 contra Combat real (Account e Inventory son dobles de prueba)', () => {
  let combat: ChildProcess | undefined
  let base = ''
  let inventory: Server
  let account: Server
  const noHero = new Set<string>()
  const upstreamCalls: string[] = []
  const logs: string[] = []
  let f: ReturnType<typeof fixture>
  let tid: string
  const admin = (): EncounterAdministration =>
    new EncounterAdministration(
      f.encounters,
      new PersistedBracketEncounterSource(f.repo),
      new HttpCombatRecordAdapter(base, SECRET),
      new HttpCombatRoomCommandAdapter(base, SECRET),
      store,
      f.clock,
      (id) => f.brackets.view(id),
    )
  let store: InMemoryEncounterAdminStore

  beforeAll(async () => {
    account = createServer((req, res) => {
      upstreamCalls.push(`account ${req.method ?? ''} ${req.url ?? ''}`)
      const match = /\/accounts\/([^/]+)\/battle-profile/u.exec(req.url ?? '')
      const out = match?.[1]
        ? json(200, {
            subject: decodeURIComponent(match[1]),
            displayName: `nombre-${decodeURIComponent(match[1])}`,
            avatarUrl: null,
          })
        : json(404, {})
      res.writeHead(out.status, { 'content-type': 'application/json' }).end(out.body)
    })
    inventory = createServer((req, res) => {
      upstreamCalls.push(`inventory ${req.method ?? ''} ${req.url ?? ''}`)
      const hero = /\/players\/([^/]+)\/equipped-hero/u.exec(req.url ?? '')
      let out = json(200, {})
      if (hero?.[1] !== undefined) {
        const player = decodeURIComponent(hero[1])
        out = noHero.has(player)
          ? json(404, { message: 'sin héroe equipado' })
          : json(200, { ...heroTemplate, playerId: player, heroId: uuidOf('hero-' + player) })
      }
      if (req.method === 'POST' && (req.url ?? '').endsWith('/battle-drops/snapshots')) {
        // Combat captura el equipamiento al iniciar: se devuelve el mismo héroe sin objetos.
        let raw = ''
        req.on('data', (chunk: Buffer) => (raw += chunk.toString()))
        req.on('end', () => {
          const snapshot = json(200, { ...(JSON.parse(raw) as object), equipment: [] })
          res.writeHead(snapshot.status, { 'content-type': 'application/json' }).end(snapshot.body)
        })
        return
      }
      res.writeHead(out.status, { 'content-type': 'application/json' }).end(out.body)
    })
    const [accountPort, inventoryPort] = await Promise.all([listen(account), listen(inventory)])
    const probe = createServer()
    const port = await listen(probe)
    await new Promise((done) => probe.close(done))
    base = `http://127.0.0.1:${String(port)}`
    combat = spawn(process.execPath, ['dist/main.js'], {
      cwd: resolve(dir ?? '.'),
      env: {
        ...process.env,
        NODE_ENV: 'development',
        PORT: String(port),
        PERSISTENCE_DRIVER: 'memory',
        AUTH_MODE: 'disabled',
        LOG_LEVEL: 'warn',
        INTERNAL_SERVICE_AUTH_SECRET: SECRET,
        ACCOUNT_SERVICE_BASE_URL: `http://127.0.0.1:${String(accountPort)}`,
        PLAYER_INVENTORY_SERVICE_BASE_URL: `http://127.0.0.1:${String(inventoryPort)}`,
      },
    })
    combat.stdout?.on('data', (chunk: Buffer) => logs.push(chunk.toString()))
    combat.stderr?.on('data', (chunk: Buffer) => logs.push(chunk.toString()))
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const response = await fetch(`${base}/api/health/live`)
        if (response.status < 500) break
      } catch {
        /* Combat todavía arranca */
      }
      await new Promise((done) => setTimeout(done, 500))
    }
  }, 60000)

  afterAll(async () => {
    combat?.kill()
    await Promise.all([
      new Promise((done) => account.close(done)),
      new Promise((done) => inventory.close(done)),
    ])
  })

  beforeEach(async () => {
    f = fixture(undefined, FREE_POLICY)
    store = new InMemoryEncounterAdminStore()
    noHero.clear()
    tid = (await f.create()).id
    for (let n = 0; n < 8; n += 1) await f.confirm(tid, n)
    await f.brackets.publish(tid, 'admin', 'pub')
  }, 30000)

  it('CA-01 real: prepara E1 en Combat, vincula la sala y registra actor/justa/acción/fecha', async () => {
    const receipt = await admin().prepare(tid, `${tid}:E1`, 'admin', 'prep-e1')
    expect(receipt).toMatchObject({ action: 'PREPARE', actor: 'admin', replayed: false })
    expect(receipt.battleId).toMatch(/^[0-9a-f-]{36}$/u)
    const encounter = await f.encounters.findOne(tid, `${tid}:E1`)
    expect(encounter).toMatchObject({ status: 'READY', combatRoomId: receipt.battleId })
    expect(encounter?.teams.flatMap((t) => t.participants.map((p) => p.playerId)).sort()).toEqual([
      'p0',
      'p1',
      'q0',
      'q1',
    ])
    expect(encounter?.teams.every((t) => t.participants.every((p) => p.heroId.length > 0))).toBe(
      true,
    )
    const started = await admin().start(tid, `${tid}:E1`, 'admin', 'start-e1')
    expect(started).toMatchObject({ status: 'IN_PROGRESS', preparationStatus: 'IN_BATTLE' })
    expect((await f.encounters.findOne(tid, `${tid}:E1`))?.startedAt).toBeInstanceOf(Date)
  }, 60000)

  it('CA-02 real: E1 y E2 se preparan e inician a la vez con salas distintas', async () => {
    const [p1, p2] = await Promise.all([
      admin().prepare(tid, `${tid}:E1`, 'admin', 'prep-e1'),
      admin().prepare(tid, `${tid}:E2`, 'admin2', 'prep-e2'),
    ])
    expect(p1.battleId).not.toBe(p2.battleId)
    const [s1, s2] = await Promise.all([
      admin().start(tid, `${tid}:E1`, 'admin', 'start-e1'),
      admin().start(tid, `${tid}:E2`, 'admin2', 'start-e2'),
    ])
    expect(s1.preparationStatus).toBe('IN_BATTLE')
    expect(s2.preparationStatus).toBe('IN_BATTLE')
  }, 60000)

  it('CA-03 real: sin participantes resueltos no se llama a Combat ni se crea sala', async () => {
    const before = upstreamCalls.length
    await expect(admin().prepare(tid, `${tid}:E5`, 'admin', 'prep-e5')).rejects.toMatchObject({
      code: 'PARTICIPANTS_UNRESOLVED',
      status: 409,
    })
    expect(upstreamCalls.length).toBe(before)
    expect(await f.encounters.findOne(tid, `${tid}:E5`)).toMatchObject({
      combatRoomId: null,
      teams: [],
      result: null,
    })
  }, 60000)

  it('CA-03 real: Combat rechaza a un jugador sin héroe equipado y no queda sala vinculada', async () => {
    noHero.add('q3')
    await expect(admin().prepare(tid, `${tid}:E2`, 'admin', 'prep-e2')).rejects.toMatchObject({
      code: 'COMBAT_REJECTED_PARTICIPANTS',
      status: 422,
    })
    expect(await f.encounters.findOne(tid, `${tid}:E2`)).toMatchObject({ combatRoomId: null })
    expect(await store.list(tid)).toEqual([])
    noHero.clear()
    expect((await admin().prepare(tid, `${tid}:E2`, 'admin', 'prep-e2-bis')).battleId).toBeTruthy()
  }, 60000)

  it('CA-04 real: repetir preparar/iniciar, también tras reiniciar el servicio de Tournament, no crea un segundo combate', async () => {
    const prepared = await admin().prepare(tid, `${tid}:E3`, 'admin', 'prep-e3')
    const started = await admin().start(tid, `${tid}:E3`, 'admin', 'start-e3')
    const again = await admin().start(tid, `${tid}:E3`, 'admin2', 'start-e3-otro')
    expect(again).toMatchObject({ battleId: started.battleId, replayed: true })
    // Una instancia nueva y un registro de recibos vacío: Combat devuelve la misma sala por operationId.
    store = new InMemoryEncounterAdminStore()
    const reborn = await admin().prepare(tid, `${tid}:E3`, 'admin3', 'prep-e3-nueva')
    expect(reborn.battleId).toBe(prepared.battleId)
    const record = await new HttpCombatRecordAdapter(base, SECRET).readRecord(prepared.battleId, 0)
    expect(record).toMatchObject({ roomId: prepared.battleId, status: 'IN_BATTLE' })
  }, 60000)

  it('un secreto HMAC distinto es rechazado por Combat y Tournament lo reporta como 503', async () => {
    const wrong = new HttpCombatRoomCommandAdapter(base, 'otro-secreto')
    await expect(
      wrong.createRoom({
        operationId: 'x',
        tournamentId: tid,
        encounterId: `${tid}:E1`,
        teams: [
          { teamId: 'a', memberIds: ['p0', 'q0'] },
          { teamId: 'b', memberIds: ['p1', 'q1'] },
        ],
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', status: 503 })
  }, 60000)
})
