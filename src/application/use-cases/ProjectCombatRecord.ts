import {
  applyCombatProjection,
  type TournamentEncounter,
} from '../../domain/entities/TournamentEncounter'
import type { CombatEventRecord } from '../../domain/entities/CombatEventRecord'
import { DomainError } from '../../domain/errors/DomainError'
import type { CombatRecordPort } from '../ports/CombatRecordPort'
import type { TournamentEncounterRepositoryPort } from '../ports/TournamentEncounterRepositoryPort'

/**
 * Lee lo nuevo del registro de Combat para una justa ya vinculada a una sala,
 * y lo proyecta sobre el estado propio de Tournament: anade los eventos
 * nuevos a la tabla de solo-anadir y actualiza estado/resultado respetando los
 * invariantes de `applyCombatProjection` (CA-03, CA-04 de HU-83).
 *
 * Es deliberadamente el UNICO lugar que escribe en la proyeccion de eventos.
 * Tanto `EnsureTournamentMatchesSeeded` (reconciliacion de arranque, hoy
 * contra el doble de desarrollo) como un futuro consumidor del aviso
 * `POST /api/internal/v1/tournaments/{id}/matches/{matchId}/sync` que describe
 * la propuesta de contrato (Management#509) deberian llamar a este caso de
 * uso en lugar de escribir la proyeccion por su cuenta.
 */
export class ProjectCombatRecord {
  constructor(
    private readonly repository: TournamentEncounterRepositoryPort,
    private readonly combat: CombatRecordPort,
  ) {}

  async execute(tournamentId: string, encounterId: string): Promise<TournamentEncounter> {
    let encounter = await this.repository.findOne(tournamentId, encounterId)

    if (encounter === null) {
      throw new DomainError(
        `No se puede sincronizar: no existe la justa "${encounterId}" del torneo "${tournamentId}".`,
      )
    }

    if (encounter.combatRoomId === null) {
      // Nada que proyectar: HU-85 todavia no vinculo una sala de Combat.
      return encounter
    }

    const roomId = encounter.combatRoomId

    do {
      const record = await this.combat.readRecord(roomId, encounter.lastSyncedSeq)

      if (record.tournamentId !== tournamentId || record.encounterId !== encounterId) {
        // Defensa de CA-01: el registro de Combat debe ser el de ESTA justa. Un
        // adaptador que devolviera el de otra sala por error nunca debe mezclarse
        // con el estado local.
        throw new DomainError(
          `El registro de Combat para la sala "${roomId}" no corresponde a la ` +
            `justa "${tournamentId}:${encounterId}".`,
        )
      }

      const events: CombatEventRecord[] = record.events.map((event) => ({
        tournamentId,
        encounterId,
        seq: event.seq,
        type: event.type,
        payload: event.payload,
        occurredAt: event.occurredAt,
      }))

      if (events.length > 0) {
        await this.repository.appendEvents(events)
      }

      const lastLocalSeq = events.reduce(
        (max, event) => Math.max(max, event.seq),
        encounter.lastSyncedSeq,
      )
      const logComplete = lastLocalSeq >= record.lastSeq

      const projected = applyCombatProjection(encounter, {
        status: record.status,
        startedAt: record.startedAt,
        result:
          record.result === null
            ? null
            : {
                winnerTeamLabel: record.result.winnerTeamLabel,
                reason: record.result.reason,
                outcome: record.result.outcome,
                finishedAt: record.result.finishedAt,
              },
        lastSeq: lastLocalSeq,
        logComplete,
      })

      await this.repository.save(projected)

      encounter = projected

      // No repetir una pagina vacia: el cursor solo avanza con eventos guardados.
      if (events.length === 0) {
        return projected
      }
    } while (!encounter.logComplete)

    return encounter
  }
}
