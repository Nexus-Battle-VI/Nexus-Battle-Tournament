import type {
  CombatRoomCommandPort,
  CreateCombatRoomInput,
  StartCombatRoomInput,
} from '../../../application/ports/CombatRoomCommandPort'
import { CombatRejectedError } from '../../../domain/encounter-admin'
import { RegistrationError, record, requireRule } from '../../../domain/registration'
import { signInternalRequest } from '../identity/internal-signature'

const ROOMS = '/api/internal/v1/combat/tournament-rooms'
const unavailable = (): RegistrationError =>
  new RegistrationError('SERVICE_UNAVAILABLE', 'Combat no está disponible.', 503)

/**
 * Escritura HTTP hacia las salas de torneo de Combat (HU-85). Misma firma HMAC
 * que la lectura. No reintenta: la idempotencia por `operationId` de Combat
 * hace seguro que el administrador repita la acción.
 */
export class HttpCombatRoomCommandAdapter implements CombatRoomCommandPort {
  constructor(
    private readonly base: string | undefined,
    private readonly secret: string | null,
  ) {}

  async createRoom(input: CreateCombatRoomInput): Promise<{ readonly roomId: string }> {
    const data = await this.post(ROOMS, input)
    requireRule(
      record(data) && typeof data.id === 'string' && data.id.length > 0,
      'SERVICE_UNAVAILABLE',
      'Combat devolvió una sala incompatible.',
      503,
    )
    return { roomId: data.id }
  }

  async startRoom(roomId: string, input: StartCombatRoomInput): Promise<void> {
    const data = await this.post(`${ROOMS}/${encodeURIComponent(roomId)}/start`, input)
    requireRule(
      record(data) && data.id === roomId,
      'SERVICE_UNAVAILABLE',
      'Combat devolvió una sala incompatible.',
      503,
    )
  }

  private async post(path: string, body: object): Promise<unknown> {
    if (!this.base || !this.secret) throw unavailable()
    const timestamp = String(Date.now())
    let response: Response
    try {
      response = await fetch(new URL(path, this.base), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-service': 'tournament',
          'x-internal-timestamp': timestamp,
          'x-internal-signature': signInternalRequest(this.secret, {
            service: 'tournament',
            method: 'POST',
            path,
            timestamp,
            body,
          }),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      })
    } catch {
      throw unavailable()
    }
    const data: unknown = await response.json().catch(() => null)
    if (response.ok) return data
    if (response.status === 422) {
      const blockers: unknown[] =
        record(data) && Array.isArray(data.blockers)
          ? data.blockers
          : record(data) && typeof data.code === 'string'
            ? [{ code: data.code }]
            : []
      const message =
        record(data) && typeof data.message === 'string'
          ? data.message
          : 'Combat rechazó a un participante.'
      throw new CombatRejectedError(message, blockers)
    }
    if (response.status === 404 || response.status === 409)
      throw new RegistrationError(
        'COMBAT_ROOM_CONFLICT',
        'Combat no reconoce la sala de esta justa.',
        409,
      )
    throw unavailable()
  }
}
