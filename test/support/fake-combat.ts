import { randomUUID } from 'node:crypto'

import type {
  CombatRecordPort,
  CombatRoomRecord,
} from '../../src/application/ports/CombatRecordPort'
import type {
  CombatRoomCommandPort,
  CreateCombatRoomInput,
  StartCombatRoomInput,
} from '../../src/application/ports/CombatRoomCommandPort'
import { CombatRejectedError } from '../../src/domain/encounter-admin'
import { RegistrationError } from '../../src/domain/registration'

interface FakeRoom {
  readonly id: string
  readonly input: CreateCombatRoomInput
  started: Date | null
}

/**
 * DOBLE DE PRUEBA, NO ES COMBAT REAL: replica solo el contrato publicado
 * (idempotencia por `operationId`, 409 con cuerpo distinto, 422 con
 * `blockers`, 503 si cae) para ejercitar a Tournament de forma determinista.
 * La verificacion contra Combat real es la tarea HU-85.4.
 */
export class FakeCombat implements CombatRoomCommandPort, CombatRecordPort {
  readonly rooms = new Map<string, FakeRoom>()
  readonly byOperation = new Map<string, { id: string; body: string }>()
  down = false
  rejected = new Set<string>()
  createCalls = 0
  startCalls = 0
  startedRooms = 0
  /** Se ejecuta tras aceptar `createRoom` y antes de responder (simula respuesta perdida). */
  afterCreate?: () => void

  createRoom(input: CreateCombatRoomInput): Promise<{ roomId: string }> {
    this.createCalls += 1
    if (this.down)
      return Promise.reject(new RegistrationError('SERVICE_UNAVAILABLE', 'Combat caído.', 503))
    const body = JSON.stringify(input)
    const known = this.byOperation.get(input.operationId)
    if (known !== undefined) {
      if (known.body !== body)
        return Promise.reject(
          new RegistrationError('COMBAT_ROOM_CONFLICT', 'Cuerpo distinto.', 409),
        )
      return Promise.resolve({ roomId: known.id })
    }
    const blockers = input.teams
      .flatMap((team) => team.memberIds)
      .filter((member) => this.rejected.has(member))
      .map((playerId) => ({ playerId, reason: 'NO_EQUIPPED_HERO' }))
    if (blockers.length > 0)
      return Promise.reject(new CombatRejectedError('Combat rechazó a un participante.', blockers))
    const id = randomUUID()
    this.rooms.set(id, { id, input, started: null })
    this.byOperation.set(input.operationId, { id, body })
    this.afterCreate?.()
    return Promise.resolve({ roomId: id })
  }

  startRoom(roomId: string, input: StartCombatRoomInput): Promise<void> {
    this.startCalls += 1
    if (this.down)
      return Promise.reject(new RegistrationError('SERVICE_UNAVAILABLE', 'Combat caído.', 503))
    const room = this.rooms.get(roomId)
    if (
      room?.input.tournamentId !== input.tournamentId ||
      room.input.encounterId !== input.encounterId
    )
      return Promise.reject(new RegistrationError('COMBAT_ROOM_CONFLICT', 'Sala ajena.', 409))
    if (room.started === null) {
      room.started = new Date('2026-10-12T15:00:00Z')
      this.startedRooms += 1
    }
    return Promise.resolve()
  }

  readRecord(roomId: string, afterSeq: number): Promise<CombatRoomRecord> {
    const room = this.rooms.get(roomId)
    if (room === undefined || this.down)
      return Promise.reject(new RegistrationError('SERVICE_UNAVAILABLE', 'Sin sala.', 503))
    return Promise.resolve({
      roomId,
      tournamentId: room.input.tournamentId,
      encounterId: room.input.encounterId,
      status: room.started === null ? 'PREPARING' : 'IN_BATTLE',
      startedAt: room.started,
      result: null,
      afterSeq,
      lastSeq: afterSeq,
      events: [],
      teams: room.input.teams.map((team) => ({
        teamLabel: team.teamId,
        participants: team.memberIds.map((playerId) => ({ playerId, heroId: 'hero-' + playerId })),
      })),
    })
  }
}
