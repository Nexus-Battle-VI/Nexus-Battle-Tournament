import {
  CombatRoomStatus,
  type CombatRecordPort,
  type CombatRoomEventWire,
  type CombatRoomRecord,
} from '../../../application/ports/CombatRecordPort'

/**
 * ============================================================================
 *  FIXTURE DE DESARROLLO — NO ES COMBAT REAL.
 * ============================================================================
 *
 * Implementa `CombatRecordPort` con datos de ejemplo fijos en lugar de llamar
 * a `GET /api/internal/v1/combat/tournament-rooms/{roomId}/record?afterSeq=N`,
 * Este doble histórico se selecciona explícitamente en pruebas; la aplicación
 * usa `HttpCombatRecordAdapter` para el contrato publicado de Combat.
 *
 * El `roomId` de este doble codifica torneo y justa
 * (`room-<tournamentId>-<encounterId>`) solo para que el stub pueda construir
 * una respuesta coherente sin guardar estado propio. Un `roomId` real de
 * Combat es un UUID opaco ("sala-uuid" en la propuesta de contrato,
 * Management#509): esta codificacion NO debe copiarse al adaptador real.
 *
 * Reemplazo previsto: un cliente HTTP que firme la peticion con
 * `signInternalRequest` de `adapters/outbound/identity/internal-signature.ts`
 * (mismo esquema HMAC que ya usa este servicio) y traduzca la respuesta de
 * Combat a este mismo `CombatRoomRecord`. Ningun caso de uso que consuma el
 * puerto deberia cambiar.
 */
export class DevFixtureCombatRecordAdapter implements CombatRecordPort {
  // `async` a proposito: incluso un `roomId` que este stub no reconoce debe
  // manifestarse como una promesa RECHAZADA, igual que lo haria un cliente
  // HTTP real, no como una excepcion sincrona que rompe antes de llegar a
  // ningun `.catch()`.
  async readRecord(roomId: string, afterSeq: number): Promise<CombatRoomRecord> {
    const parsed = /^room-(.+)-(E\d+)$/.exec(roomId)

    if (parsed === null) {
      throw new Error(
        `DevFixtureCombatRecordAdapter: "${roomId}" no es una sala de ejemplo reconocida.`,
      )
    }

    const tournamentId = parsed[1]
    const encounterId = parsed[2]

    if (tournamentId === undefined || encounterId === undefined) {
      throw new Error(
        `DevFixtureCombatRecordAdapter: "${roomId}" no es una sala de ejemplo reconocida.`,
      )
    }

    const fixture = FIXTURES[encounterId]

    if (fixture === undefined) {
      throw new Error(
        `DevFixtureCombatRecordAdapter: no hay datos de ejemplo para la justa "${encounterId}".`,
      )
    }

    const events = fixture.events
      .filter((event) => event.seq > afterSeq)
      .map((event) => ({ ...event, roomId }))

    return Promise.resolve({
      roomId,
      tournamentId,
      encounterId,
      status: fixture.status,
      startedAt: fixture.startedAt,
      result: fixture.result,
      afterSeq,
      lastSeq: fixture.events.length,
      events,
    })
  }
}

interface FixtureEntry {
  readonly status: CombatRoomStatus
  readonly startedAt: Date
  readonly result: CombatRoomRecord['result']
  readonly events: readonly CombatRoomEventWire[]
}

const eventsFor = (
  encounterId: string,
  types: readonly string[],
  base: Date,
): CombatRoomEventWire[] =>
  types.map((type, index) => ({
    roomId: `room-fixture-${encounterId}`,
    seq: index + 1,
    type,
    occurredAt: new Date(base.getTime() + index * 15_000),
    payload: { note: `evento de ejemplo ${String(index + 1)} de ${encounterId}` },
  }))

const FIXTURES: Readonly<Record<string, FixtureEntry>> = {
  E2: {
    status: CombatRoomStatus.InBattle,
    startedAt: new Date('2026-09-30T20:00:00.000Z'),
    result: null,
    events: eventsFor(
      'E2',
      ['battleStarted', 'turnResolved', 'turnResolved'],
      new Date('2026-09-30T20:00:00.000Z'),
    ),
  },
  E3: {
    status: CombatRoomStatus.Finished,
    startedAt: new Date('2026-09-30T19:00:00.000Z'),
    result: {
      winnerTeamLabel: 'A',
      reason: 'OPPONENT_DEFEATED',
      outcome: 'VICTORY',
      finishedAt: new Date('2026-09-30T19:18:00.000Z'),
    },
    events: eventsFor(
      'E3',
      ['battleStarted', 'turnResolved', 'turnResolved', 'turnResolved', 'battleFinished'],
      new Date('2026-09-30T19:00:00.000Z'),
    ),
  },
}
