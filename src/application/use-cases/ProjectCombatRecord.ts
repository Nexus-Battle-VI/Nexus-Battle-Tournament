import { sameJson } from '../../domain/json'
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
 * Lo invocan las consultas HU-83 y el reconciliador periódico de salas ya
 * vinculadas. La fuente de llaves es persistente y la lectura de Combat es
 * HTTP; los dobles de desarrollo se seleccionan explícitamente en pruebas.
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
      const snapshot = encounter

      if (
        record.roomId !== roomId ||
        record.tournamentId !== tournamentId ||
        record.encounterId !== encounterId ||
        record.afterSeq !== encounter.lastSyncedSeq
      ) {
        // Defensa de CA-01: el registro de Combat debe ser el de ESTA justa. Un
        // adaptador que devolviera el de otra sala por error nunca debe mezclarse
        // con el estado local.
        throw new DomainError(
          `El registro de Combat para la sala "${roomId}" no corresponde a la ` +
            `justa "${tournamentId}:${encounterId}".`,
        )
      }

      if (
        !Number.isSafeInteger(record.lastSeq) ||
        record.lastSeq < encounter.lastSyncedSeq ||
        record.events.length > 100 ||
        record.events.some(
          (event, index) =>
            event.roomId !== roomId ||
            event.seq !== snapshot.lastSyncedSeq + index + 1 ||
            event.seq > record.lastSeq,
        )
      )
        throw new DomainError(
          'Combat devolvió secuencias incompatibles; no se modifica el archivo.',
        )
      if (record.teams !== undefined) {
        const registered = encounter.bracketMetadata?.registeredTeams
        const mapped = record.teams.map((motor) => {
          const sameMembers = (members: readonly string[]) =>
            members.length === motor.participants.length &&
            members.every((player) => motor.participants.some((p) => p.playerId === player))
          const seed = registered?.find((team) => team !== null && sameMembers(team.memberIds))
          const prior = snapshot.teams.find((team) =>
            sameMembers(team.participants.map((p) => p.playerId)),
          )
          const teamId = seed?.teamId ?? prior?.teamId
          if (
            teamId === undefined ||
            (prior !== undefined &&
              (prior.teamLabel !== motor.teamLabel ||
                !prior.participants.every((p) =>
                  motor.participants.some(
                    (incoming) => incoming.playerId === p.playerId && incoming.heroId === p.heroId,
                  ),
                )))
          )
            throw new DomainError(
              'Los miembros o héroes de Combat no corresponden a la justa archivada.',
            )
          return { teamId, teamLabel: motor.teamLabel, participants: motor.participants }
        })
        if (mapped.length !== 2 || new Set(mapped.map((t) => t.teamId)).size !== 2)
          throw new DomainError('Combat no resolvió dos equipos distintos de la justa.')
        encounter = {
          ...encounter,
          teams: mapped,
          status: encounter.status === 'WAITING_PARTICIPANTS' ? 'READY' : encounter.status,
        }
      } else if (encounter.bracketMetadata !== undefined && encounter.teams.length === 0) {
        throw new DomainError('Falta el roster autoritativo de Combat; no se inventan héroes.')
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
        const archived = await this.repository.listEvents(
          tournamentId,
          encounterId,
          encounter.lastSyncedSeq,
          events.length,
        )
        for (const existing of archived.events) {
          const incoming = events.find((event) => event.seq === existing.seq)
          if (
            incoming !== undefined &&
            (incoming.type !== existing.type ||
              incoming.occurredAt.getTime() !== existing.occurredAt.getTime() ||
              !sameJson(incoming.payload, existing.payload))
          )
            throw new DomainError(
              'Combat intenta reescribir un evento archivado; la sincronización se detiene.',
            )
        }
        await this.repository.appendEvents(events)
      }

      const lastLocalSeq = events.reduce(
        (max, event) => Math.max(max, event.seq),
        encounter.lastSyncedSeq,
      )
      const logComplete = lastLocalSeq >= record.lastSeq

      let projected = applyCombatProjection(encounter, {
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
      if (encounter.bracketMetadata !== undefined)
        projected = {
          ...projected,
          bracketMetadata: {
            ...encounter.bracketMetadata,
            preparationStatus:
              projected.status === 'FINISHED'
                ? 'FINISHED'
                : projected.status === 'IN_PROGRESS'
                  ? 'IN_BATTLE'
                  : 'PREPARED',
            engineLastSeq: record.lastSeq,
            syncedAt: new Date().toISOString(),
          },
        }

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
