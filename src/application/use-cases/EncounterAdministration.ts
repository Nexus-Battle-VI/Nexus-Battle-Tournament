import { randomUUID } from 'node:crypto'

import type { EncounterAdminAction, EncounterAdminActionRecord } from '../../domain/encounter-admin'
import type { TournamentEncounter } from '../../domain/entities/TournamentEncounter'
import type { PublishedBracket } from '../../domain/bracket'
import { requireRule, validateOperation } from '../../domain/registration'
import type { ClockPort } from '../ports/ClockPort'
import type { CombatRecordPort } from '../ports/CombatRecordPort'
import type { CombatRoomCommandPort } from '../ports/CombatRoomCommandPort'
import type { EncounterAdminStore } from '../ports/EncounterAdminPorts'
import type { TournamentEncounterRepositoryPort } from '../ports/TournamentEncounterRepositoryPort'
import type { TournamentEncounterSourcePort } from '../ports/TournamentEncounterSourcePort'
import { EnsureTournamentMatchesSeeded } from './EnsureTournamentMatchesSeeded'
import { ProjectCombatRecord } from './ProjectCombatRecord'

export const ENCOUNTER_ADMINISTRATION = Symbol('EncounterAdministration')

export interface EncounterAdminReceipt {
  readonly actionId: string
  readonly tournamentId: string
  readonly encounterId: string
  readonly action: EncounterAdminAction
  readonly actor: string
  readonly operationId: string
  readonly occurredAt: string
  readonly replayed: boolean
  readonly battleId: string
  readonly status: string
  readonly preparationStatus: string
}

const PREPARED_STATES = ['PREPARED', 'START_PENDING', 'IN_BATTLE', 'FINISHED']

/**
 * HU-85 (Management#470): preparar e iniciar justas independientes.
 *
 * - Cada justa se serializa por si misma (candado por `torneo|justa`); nunca hay
 *   un candado de torneo ni dependencia de la transmision, de modo que E1 y E2
 *   corren a la vez (CA-02).
 * - Combat es la unica fuente de la sala: se le pide con un `operationId`
 *   DETERMINISTA por justa y accion, asi cualquier reintento, reinicio u otra
 *   instancia llega a la MISMA sala (CA-04). Los equipos salen del snapshot
 *   inmutable del bracket, nunca de la solicitud.
 * - Los recibos (actor, justa, accion, fecha) solo se escriben para acciones
 *   aceptadas, y la restriccion unica del almacen impide duplicarlos.
 * - Sin equipos resueltos o con Combat rechazando, no se crea sala, ni
 *   participantes ni ganador (CA-03).
 */
export class EncounterAdministration {
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly seeder: EnsureTournamentMatchesSeeded
  private readonly projector: ProjectCombatRecord

  constructor(
    private readonly encounters: TournamentEncounterRepositoryPort,
    source: TournamentEncounterSourcePort,
    private readonly record: CombatRecordPort,
    private readonly commands: CombatRoomCommandPort,
    private readonly store: EncounterAdminStore,
    private readonly clock: ClockPort,
    private readonly viewBracket: (tournamentId: string) => Promise<PublishedBracket | null>,
  ) {
    this.seeder = new EnsureTournamentMatchesSeeded(encounters, source, record)
    this.projector = new ProjectCombatRecord(encounters, record)
  }

  prepare(tournamentId: string, encounterId: string, actor: string, operationId: string) {
    return this.run('PREPARE', tournamentId, encounterId, actor, operationId)
  }

  start(tournamentId: string, encounterId: string, actor: string, operationId: string) {
    return this.run('START', tournamentId, encounterId, actor, operationId)
  }

  async list(tournamentId: string): Promise<readonly EncounterAdminReceipt[]> {
    await this.viewBracket(tournamentId)
    const records = await this.store.list(tournamentId)
    return Promise.all(
      records.map(async (item) =>
        this.receipt(item, await this.encounters.findOne(tournamentId, item.encounterId), true),
      ),
    )
  }

  private async run(
    action: EncounterAdminAction,
    tournamentId: string,
    encounterId: string,
    actor: string,
    operationId: string,
  ): Promise<EncounterAdminReceipt> {
    validateOperation(operationId)
    return this.exclusive(`${tournamentId}|${encounterId}`, async () => {
      const byOperation = await this.store.findByOperation(tournamentId, operationId)
      if (byOperation !== null) {
        requireRule(
          byOperation.encounterId === encounterId && byOperation.action === action,
          'OPERATION_CONFLICT',
          'El identificador corresponde a otra intención.',
          409,
        )
        return this.receipt(
          byOperation,
          await this.encounters.findOne(tournamentId, encounterId),
          true,
        )
      }
      const encounter = await this.load(tournamentId, encounterId)
      const done = await this.store.findByAction(tournamentId, encounterId, action)
      if (done !== null) return this.receipt(done, encounter, true)
      const created =
        action === 'PREPARE' ? await this.doPrepare(encounter) : await this.doStart(encounter)
      const saved = await this.store.insert({
        actionId: randomUUID(),
        tournamentId,
        encounterId,
        action,
        actor,
        operationId,
        combatRoomId: created.roomId,
        occurredAt: this.clock.now(),
      })
      return this.receipt(
        saved,
        await this.encounters.findOne(tournamentId, encounterId),
        saved.operationId !== operationId,
      )
    })
  }

  private async doPrepare(encounter: TournamentEncounter): Promise<{ roomId: string }> {
    if (encounter.combatRoomId !== null) return { roomId: encounter.combatRoomId }
    requireRule(
      encounter.status !== 'FINISHED',
      'ENCOUNTER_FINISHED',
      'La justa ya terminó y no tiene sala que preparar.',
      409,
    )
    const meta = encounter.bracketMetadata
    const [a, b] = meta?.registeredTeams ?? []
    requireRule(
      meta !== undefined &&
        meta.preparationStatus !== 'WAITING_TEAMS' &&
        a !== undefined &&
        a !== null &&
        b !== undefined &&
        b !== null &&
        meta.registeredTeams.length === 2,
      'PARTICIPANTS_UNRESOLVED',
      'La justa todavía no tiene los dos equipos resueltos.',
      409,
    )
    const { roomId } = await this.commands.createRoom({
      operationId: `tournament:${encounter.encounterId}:prepare`,
      tournamentId: encounter.tournamentId,
      encounterId: encounter.encounterId,
      teams: [
        { teamId: a.teamId, memberIds: [a.memberIds[0], a.memberIds[1]] },
        { teamId: b.teamId, memberIds: [b.memberIds[0], b.memberIds[1]] },
      ],
    })
    await this.encounters.save({
      ...encounter,
      status: 'READY',
      combatRoomId: roomId,
      bracketMetadata: { ...meta, preparationStatus: 'PREPARED' },
    })
    await this.project(encounter)
    return { roomId }
  }

  private async doStart(encounter: TournamentEncounter): Promise<{ roomId: string }> {
    const roomId = encounter.combatRoomId
    requireRule(
      roomId !== null &&
        PREPARED_STATES.includes(encounter.bracketMetadata?.preparationStatus ?? ''),
      'ENCOUNTER_NOT_PREPARED',
      'La justa debe prepararse antes de iniciarse.',
      409,
    )
    await this.commands.startRoom(roomId, {
      operationId: `tournament:${encounter.encounterId}:start`,
      tournamentId: encounter.tournamentId,
      encounterId: encounter.encounterId,
    })
    await this.project(encounter)
    const current = await this.encounters.findOne(encounter.tournamentId, encounter.encounterId)
    if (current !== null && current.status === 'READY' && current.bracketMetadata !== undefined)
      // Combat ya aceptó el inicio pero la lectura del registro aún no lo
      // refleja: se marca en curso sin inventar `startedAt`; la proyección lo
      // completa con el instante autoritativo de Combat.
      await this.encounters.save({
        ...current,
        status: 'IN_PROGRESS',
        bracketMetadata: { ...current.bracketMetadata, preparationStatus: 'IN_BATTLE' },
      })
    return { roomId }
  }

  private async project(encounter: TournamentEncounter): Promise<void> {
    await this.projector
      .execute(encounter.tournamentId, encounter.encounterId)
      .catch(() => undefined)
  }

  private async load(tournamentId: string, encounterId: string): Promise<TournamentEncounter> {
    let found = await this.encounters.findOne(tournamentId, encounterId)
    if (found === null) {
      const bracket = await this.viewBracket(tournamentId)
      requireRule(
        bracket !== null,
        'BRACKET_NOT_PUBLISHED',
        'El torneo todavía no tiene bracket publicado.',
        409,
      )
      await this.seeder.execute(tournamentId)
      found = await this.encounters.findOne(tournamentId, encounterId)
    }
    requireRule(
      found !== null,
      'ENCOUNTER_NOT_FOUND',
      'La justa no pertenece al bracket de este torneo.',
      404,
    )
    return found
  }

  private receipt(
    item: EncounterAdminActionRecord,
    encounter: TournamentEncounter | null,
    replayed: boolean,
  ): EncounterAdminReceipt {
    return {
      actionId: item.actionId,
      tournamentId: item.tournamentId,
      encounterId: item.encounterId,
      action: item.action,
      actor: item.actor,
      operationId: item.operationId,
      occurredAt: item.occurredAt.toISOString(),
      replayed,
      battleId: item.combatRoomId,
      status: encounter?.status ?? 'READY',
      preparationStatus: encounter?.bracketMetadata?.preparationStatus ?? 'PREPARED',
    }
  }

  private async exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const next = previous.then(work, work)
    const tail = next.then(
      () => undefined,
      () => undefined,
    )
    this.locks.set(key, tail)
    try {
      return await next
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key)
    }
  }
}
