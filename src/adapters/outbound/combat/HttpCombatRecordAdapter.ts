import type {
  CombatRecordPort,
  CombatRoomRecord,
  CombatRoomStatus,
} from '../../../application/ports/CombatRecordPort'
import { RegistrationError, record, requireRule, modeSize } from '../../../domain/registration'
import { signInternalRequest } from '../identity/internal-signature'
const validDate = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(new Date(value).getTime())
/** Solo lectura del contrato publicado de Combat. No crea ni inicia salas. */
export class HttpCombatRecordAdapter implements CombatRecordPort {
  constructor(
    private readonly base: string | undefined,
    private readonly secret: string | null,
  ) {}
  async readRecord(roomId: string, afterSeq: number): Promise<CombatRoomRecord> {
    requireRule(
      Boolean(this.base && this.secret),
      'SERVICE_UNAVAILABLE',
      'La lectura de Combat no está configurada.',
      503,
    )
    const path =
      '/api/internal/v1/combat/tournament-rooms/' +
      encodeURIComponent(roomId) +
      '/record?afterSeq=' +
      String(afterSeq)
    const timestamp = String(Date.now())
    let data: unknown
    try {
      const response = await fetch(new URL(path, this.base), {
        headers: {
          'x-internal-service': 'tournament',
          'x-internal-timestamp': timestamp,
          'x-internal-signature': signInternalRequest(this.secret ?? '', {
            service: 'tournament',
            method: 'GET',
            path: path.split('?')[0] ?? path,
            timestamp,
            body: {},
          }),
        },
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) throw new Error('Combat no disponible.')
      data = (await response.json()) as unknown
    } catch {
      throw new RegistrationError(
        'SERVICE_UNAVAILABLE',
        'No se pudo leer el registro de Combat.',
        503,
      )
    }
    requireRule(
      record(data) &&
        data.roomId === roomId &&
        typeof data.tournamentId === 'string' &&
        typeof data.encounterId === 'string' &&
        ['PREPARING', 'IN_BATTLE', 'FINISHED'].includes(String(data.status)) &&
        (data.startedAt === null || validDate(data.startedAt)) &&
        record(data.events) &&
        data.events.afterSeq === afterSeq &&
        Number.isSafeInteger(data.events.lastSeq) &&
        Number(data.events.lastSeq) >= afterSeq &&
        Array.isArray(data.events.items) &&
        data.events.items.length <= 100 &&
        Array.isArray(data.teams) &&
        data.teams.length === 2,
      'SERVICE_UNAVAILABLE',
      'Combat devolvió un registro incompatible.',
      503,
    )
    const page = data.events
    let teamSize = 2
    if (data.tournament !== undefined) {
      const configuration = data.tournament
      requireRule(
        record(configuration) &&
          configuration.contractVersion === 3 &&
          (configuration.mode === 'SOLO' ||
            configuration.mode === 'DUO' ||
            configuration.mode === 'TRIO') &&
          configuration.teamSize === modeSize(configuration.mode),
        'SERVICE_UNAVAILABLE',
        'Combat devolvió una modalidad incompatible.',
        503,
      )
      teamSize = modeSize(configuration.mode)
    }
    const items = page.items as unknown[]
    const labels = new Set<string>()
    const players = new Set<string>()
    const teams = data.teams.map((team: unknown) => {
      requireRule(
        record(team) &&
          typeof team.teamId === 'string' &&
          team.teamId.length > 0 &&
          !labels.has(team.teamId) &&
          Array.isArray(team.participants) &&
          team.participants.length === teamSize,
        'SERVICE_UNAVAILABLE',
        'Combat devolvió equipos incompatibles.',
        503,
      )
      labels.add(team.teamId)
      return {
        teamLabel: team.teamId,
        participants: team.participants.map((participant: unknown) => {
          requireRule(
            record(participant) &&
              participant.kind === 'HUMAN' &&
              typeof participant.playerId === 'string' &&
              participant.playerId.length > 0 &&
              !players.has(participant.playerId) &&
              typeof participant.heroId === 'string' &&
              participant.heroId.length > 0,
            'SERVICE_UNAVAILABLE',
            'Combat devolvió participantes incompatibles.',
            503,
          )
          players.add(participant.playerId)
          return { playerId: participant.playerId, heroId: participant.heroId }
        }),
      }
    })
    let result: CombatRoomRecord['result'] = null
    if (data.result !== null) {
      const raw = data.result
      requireRule(
        data.status === 'FINISHED' &&
          record(raw) &&
          validDate(raw.finishedAt) &&
          ['ELIMINATION', 'DISCONNECTION', 'TIME_LIMIT'].includes(String(raw.reason)) &&
          (raw.outcome === 'WIN' || raw.outcome === 'NO_WINNER') &&
          (raw.outcome === 'NO_WINNER'
            ? raw.winnerTeamLabel === null
            : typeof raw.winnerTeamLabel === 'string' && labels.has(raw.winnerTeamLabel)),
        'SERVICE_UNAVAILABLE',
        'Combat devolvió un resultado incompatible.',
        503,
      )
      result = {
        winnerTeamLabel: raw.winnerTeamLabel as string | null,
        reason: String(raw.reason),
        outcome: raw.outcome,
        finishedAt: new Date(raw.finishedAt),
      }
    }
    const events = items.map((item: unknown, index) => {
      requireRule(
        record(item) &&
          item.roomId === roomId &&
          item.seq === afterSeq + index + 1 &&
          item.seq <= Number(page.lastSeq) &&
          typeof item.type === 'string' &&
          validDate(item.occurredAt),
        'SERVICE_UNAVAILABLE',
        'Combat devolvió secuencias incompatibles.',
        503,
      )
      return {
        roomId,
        seq: item.seq,
        type: item.type,
        occurredAt: new Date(item.occurredAt),
        payload: item,
      }
    })
    requireRule(
      events.length > 0 || afterSeq === Number(page.lastSeq),
      'SERVICE_UNAVAILABLE',
      'La página de Combat no permite avanzar el cursor.',
      503,
    )
    return {
      roomId,
      tournamentId: data.tournamentId,
      encounterId: data.encounterId,
      status: data.status as CombatRoomStatus,
      startedAt: data.startedAt === null ? null : new Date(data.startedAt),
      result,
      afterSeq,
      lastSeq: Number(page.lastSeq),
      events,
      teams,
    }
  }
}
