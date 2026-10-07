import { HttpCombatRecordAdapter } from '../../src/adapters/outbound/combat/HttpCombatRecordAdapter'
import { HttpCombatRoomCommandAdapter } from '../../src/adapters/outbound/combat/HttpCombatRoomCommandAdapter'
import { InMemoryEncounterAdminStore } from '../../src/adapters/outbound/persistence/InMemoryEncounterAdminStore'
import { PersistedBracketEncounterSource } from '../../src/adapters/outbound/bracket/PersistedBracketEncounterSource'
import { EncounterAdministration } from '../../src/application/use-cases/EncounterAdministration'
import { fixture, FREE_POLICY } from '../support/registration-fixture'
import { startRealCombat, type RealCombat } from '../support/real-combat'

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

suite('HU-85.4 contra Combat real (Account e Inventory son dobles de prueba)', () => {
  let real: RealCombat
  let base = ''
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
    real = await startRealCombat(dir ?? '.', SECRET)
    base = real.base
  }, 90000)

  afterAll(async () => {
    await real.stop()
  })

  beforeEach(async () => {
    f = fixture(undefined, FREE_POLICY)
    store = new InMemoryEncounterAdminStore()
    real.noHero.clear()
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
    const before = real.upstreamCalls.length
    await expect(admin().prepare(tid, `${tid}:E5`, 'admin', 'prep-e5')).rejects.toMatchObject({
      code: 'PARTICIPANTS_UNRESOLVED',
      status: 409,
    })
    expect(real.upstreamCalls.length).toBe(before)
    expect(await f.encounters.findOne(tid, `${tid}:E5`)).toMatchObject({
      combatRoomId: null,
      teams: [],
      result: null,
    })
  }, 60000)

  it('CA-03 real: Combat rechaza a un jugador sin héroe equipado y no queda sala vinculada', async () => {
    real.noHero.add('q3')
    await expect(admin().prepare(tid, `${tid}:E2`, 'admin', 'prep-e2')).rejects.toMatchObject({
      code: 'COMBAT_REJECTED_PARTICIPANTS',
      status: 422,
    })
    expect(await f.encounters.findOne(tid, `${tid}:E2`)).toMatchObject({ combatRoomId: null })
    expect(await store.list(tid)).toEqual([])
    real.noHero.clear()
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

  it('C10 real: Combat inalcanzable da 503 sin cambiar nada y el reintento llega a una sola sala', async () => {
    const down = new EncounterAdministration(
      f.encounters,
      new PersistedBracketEncounterSource(f.repo),
      new HttpCombatRecordAdapter('http://127.0.0.1:1', SECRET),
      new HttpCombatRoomCommandAdapter('http://127.0.0.1:1', SECRET),
      store,
      f.clock,
      (id) => f.brackets.view(id),
    )
    await expect(down.prepare(tid, `${tid}:E1`, 'admin', 'prep-e1')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      status: 503,
    })
    expect(await f.encounters.findOne(tid, `${tid}:E1`)).toMatchObject({ combatRoomId: null })
    expect(await store.list(tid)).toEqual([])
    const retry = await admin().prepare(tid, `${tid}:E1`, 'admin', 'prep-e1')
    expect((await admin().prepare(tid, `${tid}:E1`, 'admin', 'prep-e1')).battleId).toBe(
      retry.battleId,
    )
    expect(await store.list(tid)).toHaveLength(1)
  }, 60000)

  it('C11/C12 real: operationId en conflicto, iniciar sin preparar y sala ajena en Combat', async () => {
    await admin().prepare(tid, `${tid}:E1`, 'admin', 'misma')
    await expect(admin().prepare(tid, `${tid}:E2`, 'admin', 'misma')).rejects.toMatchObject({
      code: 'OPERATION_CONFLICT',
      status: 409,
    })
    await expect(admin().start(tid, `${tid}:E3`, 'admin', 'start-e3')).rejects.toMatchObject({
      code: 'ENCOUNTER_NOT_PREPARED',
      status: 409,
    })
    const commands = new HttpCombatRoomCommandAdapter(base, SECRET)
    // Combat real: el mismo operationId con otro cuerpo es 409, y una sala inexistente también.
    await expect(
      commands.createRoom({
        operationId: `tournament:${tid}:E1:prepare`,
        tournamentId: tid,
        encounterId: `${tid}:E1`,
        teams: [
          { teamId: 'otro-a', memberIds: ['p0', 'q0'] },
          { teamId: 'otro-b', memberIds: ['p1', 'q1'] },
        ],
      }),
    ).rejects.toMatchObject({ code: 'COMBAT_ROOM_CONFLICT', status: 409 })
    await expect(
      commands.startRoom('11111111-1111-4111-8111-111111111111', {
        operationId: 'x',
        tournamentId: tid,
        encounterId: `${tid}:E1`,
      }),
    ).rejects.toMatchObject({ code: 'COMBAT_ROOM_CONFLICT', status: 409 })
    expect(await store.list(tid)).toHaveLength(1)
  }, 60000)

  it('CA-04 real: dos instancias del servicio compiten por la misma justa y Combat da una sola sala', async () => {
    const [a, b] = await Promise.all([
      admin().prepare(tid, `${tid}:E1`, 'admin', 'prep-a'),
      admin().prepare(tid, `${tid}:E1`, 'admin2', 'prep-b'),
    ])
    expect(a.battleId).toBe(b.battleId)
    const [s1, s2] = await Promise.all([
      admin().start(tid, `${tid}:E1`, 'admin', 'start-a'),
      admin().start(tid, `${tid}:E1`, 'admin2', 'start-b'),
    ])
    expect(s1.battleId).toBe(a.battleId)
    expect(s2.battleId).toBe(a.battleId)
    const actions = await store.list(tid)
    expect(actions.filter((x) => x.action === 'PREPARE')).toHaveLength(1)
    expect(actions.filter((x) => x.action === 'START')).toHaveLength(1)
    const record = await new HttpCombatRecordAdapter(base, SECRET).readRecord(a.battleId, 0)
    expect(record.status).toBe('IN_BATTLE')
  }, 60000)

  it('C13 real: iniciar mucho después de la hora no fija resultado ni cierre (solo Combat o la ausencia resuelta los fijan)', async () => {
    await admin().prepare(tid, `${tid}:E1`, 'admin', 'prep-e1')
    f.setNow('2027-12-31T00:00:00Z')
    await expect(admin().prepare(tid, `${tid}:E5`, 'admin', 'prep-e5')).rejects.toMatchObject({
      status: 409,
    })
    const started = await admin().start(tid, `${tid}:E1`, 'admin', 'start-e1')
    const encounter = await f.encounters.findOne(tid, `${tid}:E1`)
    expect(started.status).toBe('IN_PROGRESS')
    expect(encounter).toMatchObject({ result: null, closedAt: null })
    expect(encounter?.status).not.toBe('FINISHED')
    const record = await new HttpCombatRecordAdapter(base, SECRET).readRecord(started.battleId, 0)
    expect(record.result).toBeNull()
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
