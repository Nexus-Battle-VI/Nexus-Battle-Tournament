import type { PublishedBracket } from '../../domain/bracket'
import {
  acceptanceDeadline,
  decideAbsence,
  type AbsenceKind,
  type AbsenceResolution,
  type AbsenceTeam,
} from '../../domain/absence'
import type { TournamentEncounter } from '../../domain/entities/TournamentEncounter'
import { RegistrationError, requireRule } from '../../domain/registration'
import type { AbsenceStore } from '../ports/AbsencePorts'
import type { ClockPort } from '../ports/ClockPort'
import type { CombatRecordPort } from '../ports/CombatRecordPort'
import type { RegistrationRepository } from '../ports/RegistrationPorts'
import type { TournamentEncounterRepositoryPort } from '../ports/TournamentEncounterRepositoryPort'
import type { TournamentEncounterSourcePort } from '../ports/TournamentEncounterSourcePort'
import { EnsureTournamentMatchesSeeded } from './EnsureTournamentMatchesSeeded'

export const ENCOUNTER_ABSENCES = Symbol('EncounterAbsences')

export interface ReadinessView {
  readonly tournamentId: string
  readonly encounterId: string
  /** Hora programada; `null` mientras la justa no tenga horario definido. */
  readonly scheduledAt: string | null
  readonly acceptanceDeadline: string | null
  readonly windowOpen: boolean
  readonly teams: readonly {
    readonly teamId: string
    readonly ready: boolean
    readonly members: readonly { readonly playerId: string; readonly accepted: boolean }[]
  }[]
  /** Avance por ausencia ya resuelto, o `null`. */
  readonly resolution: {
    readonly winnerTeamId: string
    readonly kind: AbsenceKind
    readonly readyCounts: readonly [number, number]
    readonly resolvedAt: string
  } | null
}

const teamsOf = (encounter: TournamentEncounter): readonly [AbsenceTeam, AbsenceTeam] | null => {
  const [a, b] = encounter.bracketMetadata?.registeredTeams ?? []
  return a === undefined || a === null || b === undefined || b === null
    ? null
    : [
        { teamId: a.teamId, memberIds: a.memberIds },
        { teamId: b.teamId, memberIds: b.memberIds },
      ]
}

/**
 * Ventana de aceptación y avance por ausencia (decisión de Carlos sobre HU-85).
 *
 * Horario: lo definido al crear el torneo es su inicio (`startsAt`); las
 * justas de la primera ronda se programan a esa hora. Las rondas posteriores
 * NO tienen horario definido todavía: no se inventa uno, así que no tienen
 * ventana ni avance automático hasta que se defina.
 */
export class EncounterAbsences {
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly seeder: EnsureTournamentMatchesSeeded

  constructor(
    private readonly encounters: TournamentEncounterRepositoryPort,
    source: TournamentEncounterSourcePort,
    record: CombatRecordPort,
    private readonly store: AbsenceStore,
    private readonly clock: ClockPort,
    private readonly registrations: RegistrationRepository,
    private readonly random: () => number = () => Math.random(),
  ) {
    this.seeder = new EnsureTournamentMatchesSeeded(encounters, source, record)
  }

  /** Un integrante acepta el combate dentro de la ventana de su justa. */
  async accept(tournamentId: string, encounterId: string, subject: string): Promise<ReadinessView> {
    return this.exclusive(`${tournamentId}|${encounterId}`, async () => {
      const { encounter, bracket } = await this.load(tournamentId, encounterId)
      const teams = teamsOf(encounter)
      requireRule(
        teams !== null,
        'PARTICIPANTS_UNRESOLVED',
        'La justa todavía no tiene los dos equipos resueltos.',
        409,
      )
      requireRule(
        teams.some((team) => team.memberIds.includes(subject)),
        'NOT_A_PARTICIPANT',
        'Solo los integrantes de los dos equipos pueden aceptar este combate.',
        403,
      )
      const scheduledAt = this.scheduledAt(encounter, bracket)
      requireRule(
        scheduledAt !== null,
        'NOT_SCHEDULED',
        'Esta justa todavía no tiene horario definido.',
        409,
      )
      requireRule(
        encounter.status !== 'FINISHED' &&
          (await this.store.findResolution(tournamentId, encounterId)) === null,
        'ENCOUNTER_FINISHED',
        'La justa ya terminó.',
        409,
      )
      const now = this.clock.now()
      requireRule(
        now >= scheduledAt,
        'ACCEPTANCE_NOT_OPEN',
        'La ventana para aceptar el combate todavía no abre.',
        409,
      )
      requireRule(
        now <= acceptanceDeadline(scheduledAt),
        'ACCEPTANCE_CLOSED',
        'La ventana de dos minutos para aceptar el combate ya cerró.',
        409,
      )
      await this.store.accept({ tournamentId, encounterId, playerId: subject, acceptedAt: now })
      return this.build(encounter, bracket)
    })
  }

  async view(tournamentId: string, encounterId: string): Promise<ReadinessView> {
    const { encounter, bracket } = await this.load(tournamentId, encounterId)
    return this.build(encounter, bracket)
  }

  /**
   * Resuelve el avance por ausencia de las justas cuya ventana ya cerró.
   * Idempotente: una justa ya resuelta, terminada, con sala de Combat (la
   * administró el administrador) o con ambos equipos listos no se toca.
   */
  async sweep(): Promise<number> {
    let resolved = 0
    for (const tournament of await this.registrations.list()) {
      if (tournament.bracket === null) continue
      const bracket = tournament.bracket
      if (this.clock.now() <= acceptanceDeadline(new Date(bracket.startsAt))) continue
      await this.seeder.execute(tournament.id)
      for (const encounter of await this.encounters.findAllByTournament(tournament.id)) {
        if (encounter.round !== 1) continue
        if (await this.resolveOne(tournament.id, encounter.encounterId)) resolved += 1
      }
    }
    return resolved
  }

  /** Devuelve `true` si esta llamada dejó la justa resuelta por ausencia. */
  async resolveOne(tournamentId: string, encounterId: string): Promise<boolean> {
    return this.exclusive(`${tournamentId}|${encounterId}`, async () => {
      const { encounter, bracket } = await this.load(tournamentId, encounterId)
      const teams = teamsOf(encounter)
      const scheduledAt = this.scheduledAt(encounter, bracket)
      if (teams === null || scheduledAt === null) return false
      if (this.clock.now() <= acceptanceDeadline(scheduledAt)) return false
      let resolution = await this.store.findResolution(tournamentId, encounterId)
      if (resolution === null) {
        if (encounter.status === 'FINISHED' || encounter.combatRoomId !== null) return false
        const ready = new Set(
          (await this.store.listReady(tournamentId, encounterId)).map((r) => r.playerId),
        )
        const decision = decideAbsence(teams, ready, this.random)
        if (decision === null) return false
        resolution = await this.store.saveResolution({
          tournamentId,
          encounterId,
          winnerTeamId: teams[decision.winnerIndex].teamId,
          kind: decision.kind,
          readyCounts: decision.readyCounts,
          resolvedAt: this.clock.now(),
        })
      }
      if (encounter.status === 'FINISHED') return false
      await this.apply(encounter, resolution)
      return true
    })
  }

  /**
   * Registra el avance como una victoria normal pero distinguible de un
   * combate: `reason: 'ABSENCE'`, sin sala ni eventos de Combat.
   */
  private async apply(encounter: TournamentEncounter, resolution: AbsenceResolution) {
    await this.encounters.save({
      ...encounter,
      status: 'FINISHED',
      closedAt: resolution.resolvedAt,
      result: {
        winnerTeamLabel: resolution.winnerTeamId,
        reason: 'ABSENCE',
        outcome: 'WIN',
        finishedAt: resolution.resolvedAt,
      },
      ...(encounter.bracketMetadata === undefined
        ? {}
        : {
            bracketMetadata: { ...encounter.bracketMetadata, preparationStatus: 'FINISHED' },
          }),
    })
  }

  private scheduledAt(encounter: TournamentEncounter, bracket: PublishedBracket): Date | null {
    return encounter.round === 1 ? new Date(bracket.startsAt) : null
  }

  private async build(
    encounter: TournamentEncounter,
    bracket: PublishedBracket,
  ): Promise<ReadinessView> {
    const teams = teamsOf(encounter)
    const scheduledAt = this.scheduledAt(encounter, bracket)
    const ready = new Set(
      (await this.store.listReady(encounter.tournamentId, encounter.encounterId)).map(
        (r) => r.playerId,
      ),
    )
    const resolution = await this.store.findResolution(
      encounter.tournamentId,
      encounter.encounterId,
    )
    const now = this.clock.now()
    return {
      tournamentId: encounter.tournamentId,
      encounterId: encounter.encounterId,
      scheduledAt: scheduledAt?.toISOString() ?? null,
      acceptanceDeadline:
        scheduledAt === null ? null : acceptanceDeadline(scheduledAt).toISOString(),
      windowOpen:
        scheduledAt !== null && now >= scheduledAt && now <= acceptanceDeadline(scheduledAt),
      teams: (teams ?? []).map((team) => ({
        teamId: team.teamId,
        ready: team.memberIds.every((id) => ready.has(id)),
        members: team.memberIds.map((playerId) => ({ playerId, accepted: ready.has(playerId) })),
      })),
      resolution:
        resolution === null
          ? null
          : {
              winnerTeamId: resolution.winnerTeamId,
              kind: resolution.kind,
              readyCounts: resolution.readyCounts,
              resolvedAt: resolution.resolvedAt.toISOString(),
            },
    }
  }

  private async load(
    tournamentId: string,
    encounterId: string,
  ): Promise<{ encounter: TournamentEncounter; bracket: PublishedBracket }> {
    const tournament = await this.registrations.read(tournamentId)
    const bracket = tournament.bracket
    requireRule(
      bracket !== null,
      'BRACKET_NOT_PUBLISHED',
      'El torneo todavía no tiene bracket publicado.',
      409,
    )
    let encounter = await this.encounters.findOne(tournamentId, encounterId)
    if (encounter === null) {
      await this.seeder.execute(tournamentId)
      encounter = await this.encounters.findOne(tournamentId, encounterId)
    }
    if (encounter === null)
      throw new RegistrationError(
        'ENCOUNTER_NOT_FOUND',
        'La justa no pertenece al bracket de este torneo.',
        404,
      )
    return { encounter, bracket }
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
