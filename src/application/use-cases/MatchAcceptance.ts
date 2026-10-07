import { randomUUID } from 'node:crypto'
import {
  acceptanceCounts,
  ACCEPTANCE_POLICY,
  closeAcceptance,
  MAX_OBSERVATION_GAP_MS,
  type MatchAcceptanceState,
  type ResolvedTeam,
} from '../../domain/match-acceptance'
import { requireRule, validateOperation } from '../../domain/registration'
import { projectBracket } from '../../domain/progression'
import {
  acceptanceReceipt,
  absenceResolution,
  playedResolution,
  type ConvocationExtension,
} from '../../domain/convocation'
import type { RegistrationRepository } from '../ports/RegistrationPorts'
import type { MatchAcceptanceStore, FairRandomPort } from '../ports/MatchAcceptancePorts'
import type { ClockPort } from '../ports/ClockPort'
import type { Progressions } from './Progressions'
export const MATCH_ACCEPTANCE = Symbol('MatchAcceptance')
export class MatchAcceptance {
  constructor(
    readonly store: MatchAcceptanceStore,
    private readonly tournaments: RegistrationRepository,
    private readonly progress: Progressions,
    readonly clock: ClockPort,
    private readonly random: FairRandomPort,
  ) {}
  private async context(id: string, encounterId: string) {
    const t = await this.tournaments.read(id)
    requireRule(
      t.acceptancePolicy === ACCEPTANCE_POLICY,
      'LEGACY_ACCEPTANCE_DISABLED',
      'Este torneo conserva la administración anterior.',
      409,
    )
    const match = t.bracket?.matches.find((m) => m.encounterId === encounterId)
    requireRule(
      match !== undefined,
      'ENCOUNTER_NOT_FOUND',
      'La justa no pertenece al bracket publicado.',
      404,
    )
    const window = t.roundWindows?.find((w) => w.round === match.round)
    requireRule(window !== undefined, 'SCHEDULE_UNAVAILABLE', 'Falta la ventana persistida.', 503)
    const state = await this.progress.repository.read(id)
    const projected =
      t.bracket === null
        ? undefined
        : projectBracket(t.bracket, state.results).matches.find(
            (m) => m.encounterId === encounterId,
          )
    const dependencies = match.sources.flatMap((s) =>
      s.kind === 'SEED' ? [] : [state.results.find((r) => r.matchId === s.matchId)],
    )
    const readyOnTime = dependencies.every(
      (r) =>
        r !== undefined &&
        r.winnerTeamId !== null &&
        new Date(r.confirmedAt).getTime() <= new Date(window.acceptanceOpensAt).getTime(),
    )
    const teams = projected?.teamIds.map((teamId) =>
      t.bracket?.seeds.find((s) => s.teamId === teamId),
    )
    const roster =
      teams?.length === 2 && teams.every((team) => team !== undefined)
        ? (teams.map((team) => ({ teamId: team.teamId, memberIds: team.memberIds })) as [
            ResolvedTeam,
            ResolvedTeam,
          ])
        : null
    const initial: MatchAcceptanceState = {
      tournamentId: id,
      encounterId,
      tournamentMode: t.tournamentMode ?? 'DUO',
      teamSize: t.teamSize ?? 2,
      window,
      phase: 'SCHEDULED',
      openedAt: null,
      lastObservedAt: null,
      decidedAt: null,
      roster: null,
      acceptances: [],
      operations: {},
      decision: null,
      resolution: null,
      combatIntent: null,
      blocker: null,
    }
    return { initial, roster, readyOnTime }
  }
  private observe(
    s: MatchAcceptanceState,
    roster: [ResolvedTeam, ResolvedTeam] | null,
    readyOnTime: boolean,
    now: Date,
  ): void {
    if (s.phase === 'OPEN') {
      if (
        now.getTime() >= new Date(s.window.acceptanceClosesAt).getTime() &&
        !acceptanceCounts(s).every((c) => c === s.teamSize) &&
        (s.lastObservedAt === null ||
          now.getTime() - new Date(s.lastObservedAt).getTime() >= MAX_OBSERVATION_GAP_MS)
      ) {
        s.phase = 'BLOCKED'
        s.blocker = {
          code: 'WINDOW_INTERRUPTED',
          message:
            'Falta observación operativa reciente al cierre. Requiere revisión; no se infiere una ausencia.',
          responsible: 'TOURNAMENT_OPERATIONS',
          since: now.toISOString(),
        }
      } else {
        s.lastObservedAt = now.toISOString()
      }
      return
    }
    if (s.phase !== 'SCHEDULED' || now.getTime() < new Date(s.window.acceptanceOpensAt).getTime())
      return
    if (now.getTime() >= new Date(s.window.acceptanceClosesAt).getTime()) {
      s.phase = 'BLOCKED'
      s.blocker = {
        since: now.toISOString(),
        code: 'WINDOW_MISSED',
        message:
          'La ventana terminó sin activación válida. Requiere revisión, sin ausencia ni reprogramación.',
        responsible: 'TOURNAMENT_OPERATIONS',
      }
      return
    }
    if (roster === null || !readyOnTime) {
      s.phase = 'BLOCKED'
      s.blocker = {
        since: now.toISOString(),
        code: 'DEPENDENCIES_DELAYED',
        message: 'Faltan resultados confirmados a la apertura. El horario permanece bloqueado.',
        responsible: 'TOURNAMENT_OPERATIONS',
      }
      return
    }
    s.roster = structuredClone(roster)
    s.openedAt = now.toISOString()
    s.lastObservedAt = now.toISOString()
    s.phase = 'OPEN'
  }
  async accept(id: string, encounterId: string, subject: string, operationId: string) {
    validateOperation(operationId)
    const { initial, roster, readyOnTime } = await this.context(id, encounterId)
    return this.store.change(initial, (s) => {
      const now = this.clock.now()
      this.observe(s, roster, readyOnTime, now)
      const team = (s.roster ?? roster)?.find((team) => team.memberIds.includes(subject))
      requireRule(
        team !== undefined,
        'FORBIDDEN',
        'Solo un jugador del roster resuelto puede aceptar.',
        403,
      )
      const prior = Object.hasOwn(s.operations, operationId) ? s.operations[operationId] : undefined
      // No se usa ningún actor, héroe o conteo del cuerpo. Los aliases también quedan durables.
      if (prior !== undefined) {
        requireRule(
          prior.subject === subject,
          'OPERATION_CONFLICT',
          'La operación pertenece a otro jugador.',
          409,
        )
      }
      const accepted = s.acceptances.find((a) => a.subject === subject)
      if (accepted !== undefined) {
        Object.defineProperty(s.operations, operationId, {
          value: { subject, receiptId: accepted.receiptId },
          enumerable: true,
          writable: true,
          configurable: true,
        })
        return acceptanceReceipt(accepted, s.window, true)
      }
      requireRule(
        s.phase === 'OPEN' &&
          now.getTime() >= new Date(s.window.acceptanceOpensAt).getTime() &&
          now.getTime() < new Date(s.window.acceptanceClosesAt).getTime(),
        now.getTime() < new Date(s.window.acceptanceOpensAt).getTime()
          ? 'ACCEPTANCE_NOT_OPEN'
          : 'ACCEPTANCE_CLOSED',
        'La aceptación no está abierta.',
        409,
      )
      const receipt = {
        receiptId: randomUUID(),
        tournamentId: id,
        encounterId,
        teamId: team.teamId,
        subject,
        operationId,
        acceptedAt: now.toISOString(),
      }
      s.acceptances.push(receipt)
      Object.defineProperty(s.operations, operationId, {
        value: { subject, receiptId: receipt.receiptId },
        enumerable: true,
        writable: true,
        configurable: true,
      })
      return acceptanceReceipt(receipt, s.window, false)
    })
  }
  async decide(id: string, encounterId: string): Promise<MatchAcceptanceState> {
    const { initial, roster, readyOnTime } = await this.context(id, encounterId)
    return this.store.change(initial, (s) => {
      const now = this.clock.now()
      this.observe(s, roster, readyOnTime, now)
      if (now.getTime() >= new Date(s.window.acceptanceClosesAt).getTime())
        closeAcceptance(s, now, randomUUID(), () => this.random.bit())
      return s
    })
  }
  async guard(id: string, encounterId: string): Promise<void> {
    const s = await this.store.read(id, encounterId)
    requireRule(
      s !== null &&
        s.phase === 'CLOSED' &&
        s.decision === 'COMBAT' &&
        this.clock.now().getTime() >= new Date(s.window.acceptanceClosesAt).getTime() &&
        acceptanceCounts(s).every((c) => c === s.teamSize),
      'ACCEPTANCE_REQUIRED',
      'Se requiere el cierre durable con ambos equipos completos.',
      409,
    )
  }
  async view(
    id: string,
    encounterId: string,
    subject?: string,
  ): Promise<ConvocationExtension | null> {
    const t = await this.tournaments.read(id)
    if (t.acceptancePolicy !== ACCEPTANCE_POLICY) return null
    const { initial } = await this.context(id, encounterId),
      s = (await this.store.read(id, encounterId)) ?? initial
    const progress = (await this.progress.bracket(id))?.matches.find(
      (m) => m.encounterId === encounterId,
    )
    const result = (await this.progress.repository.read(id)).results.find(
      (r) => r.encounterId === encounterId,
    )
    const resolution =
      s.resolution !== null
        ? absenceResolution(s.resolution, s.teamSize)
        : result === undefined
          ? null
          : playedResolution(result)
    const own = s.acceptances.find((a) => a.subject === subject)
    const now = this.clock.now()
    const deadlinePassed = now.getTime() >= new Date(s.window.acceptanceClosesAt).getTime()
    return {
      ...s.window,
      contractVersion: 'torneos-v3.0.0',
      tournamentMode: s.tournamentMode,
      teamSize: s.teamSize,
      serverNow: now.toISOString(),
      acceptanceStatus:
        resolution !== null
          ? 'RESOLVED'
          : s.phase === 'BLOCKED'
            ? 'BLOCKED_DELAY'
            : s.phase === 'OPEN' && deadlinePassed
              ? 'CLOSED'
              : s.phase,
      operationalStatus:
        resolution !== null
          ? 'FINISHED'
          : s.blocker !== null
            ? 'DEPENDENCY_ERROR'
            : s.combatIntent?.phase === 'STARTED'
              ? 'IN_BATTLE'
              : (s.combatIntent?.phase ??
                (s.phase === 'CLOSED' || (s.phase === 'OPEN' && deadlinePassed)
                  ? 'RESOLUTION_PENDING'
                  : 'IDLE')),
      acceptedCounts: acceptanceCounts(s),
      myAcceptance: own === undefined ? null : acceptanceReceipt(own, s.window, true),
      blockReason:
        s.blocker === null
          ? null
          : {
              ...s.blocker,
              code:
                s.blocker.code === 'DEPENDENCIES_DELAYED'
                  ? 'PREVIOUS_RESULT_PENDING'
                  : s.blocker.code,
            },
      resolution,
      winnerTeamId: progress?.winnerTeamId ?? s.resolution?.winnerTeamId ?? null,
      loserTeamId: progress?.loserTeamId ?? s.resolution?.loserTeamId ?? null,
      sources: progress?.sources,
      destinations: progress?.destinations,
    }
  }
}
