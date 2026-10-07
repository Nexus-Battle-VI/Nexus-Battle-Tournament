import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'

/**
 * Arranca el servicio Combat REAL (`node dist/main.js`, ya compilado) con
 * Account y Player-Inventory como DOBLES DE PRUEBA locales mínimos (no validan
 * la firma HMAC). Usado por la verificación HU-85.4; Combat usa su
 * persistencia en memoria.
 */
const heroTemplate = JSON.parse(
  readFileSync(join(__dirname, 'combat-equipped-hero.json'), 'utf8'),
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

export interface RealCombat {
  readonly base: string
  /** Jugadores a los que el doble de Inventory responde «sin héroe equipado». */
  readonly noHero: Set<string>
  /** Llamadas que Combat hizo a los dobles de Account/Inventory. */
  readonly upstreamCalls: string[]
  readonly stop: () => Promise<void>
}

export const startRealCombat = async (dir: string, secret: string): Promise<RealCombat> => {
  const noHero = new Set<string>()
  const upstreamCalls: string[] = []
  const account = createServer((req, res) => {
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
  const inventory = createServer((req, res) => {
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
  const base = `http://127.0.0.1:${String(port)}`
  const combat: ChildProcess = spawn(process.execPath, ['dist/main.js'], {
    cwd: resolve(dir),
    // Sin tubería: si nadie lee la salida, el búfer se llena y Combat se bloquea.
    stdio: 'ignore',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      PERSISTENCE_DRIVER: 'memory',
      AUTH_MODE: 'disabled',
      LOG_LEVEL: 'warn',
      INTERNAL_SERVICE_AUTH_SECRET: secret,
      ACCOUNT_SERVICE_BASE_URL: `http://127.0.0.1:${String(accountPort)}`,
      PLAYER_INVENTORY_SERVICE_BASE_URL: `http://127.0.0.1:${String(inventoryPort)}`,
    },
  })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health/live`)
      if (response.status < 500) break
    } catch {
      /* Combat todavía arranca */
    }
    await new Promise((done) => setTimeout(done, 500))
  }
  return {
    base,
    noHero,
    upstreamCalls,
    stop: async () => {
      combat.kill()
      await Promise.all([
        new Promise((done) => account.close(done)),
        new Promise((done) => inventory.close(done)),
      ])
    },
  }
}
