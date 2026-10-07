import { randomUUID } from 'node:crypto'
import type { RegistrationRepository } from '../ports/RegistrationPorts'
import { ACCEPTANCE_POLICY } from '../../domain/match-acceptance'
import { RegistrationError } from '../../domain/registration'
import type { MatchAcceptance } from './MatchAcceptance'
import type { EncounterAdministration } from './EncounterAdministration'
import type { Progressions } from './Progressions'
export const ACCEPTANCE_RECONCILIATION = Symbol('AcceptanceReconciliation')
/** Intención persistida antes de HTTP. Cada worker reclama una lease de esa justa. */
export class AcceptanceReconciliation {
  constructor(
    private readonly tournaments: RegistrationRepository,
    private readonly acceptance: MatchAcceptance,
    private readonly administration: EncounterAdministration,
    private readonly progress: Progressions,
  ) {}
  async sweep(): Promise<void> {
    await this.progress.reconcile()
    const tournaments = await this.tournaments.list()
    await Promise.allSettled(
      tournaments
        .filter((t) => t.acceptancePolicy === ACCEPTANCE_POLICY && t.bracket !== null)
        .flatMap((t) => (t.bracket?.matches ?? []).map((m) => this.run(t.id, m.encounterId))),
    )
  }
  async run(id: string, encounterId: string): Promise<void> {
    const state = await this.acceptance.decide(id, encounterId)
    if (state.decision === 'TOURNAMENT') {
      await this.progress.confirm(id, encounterId)
      return
    }
    if (state.combatIntent === null || state.combatIntent.phase === 'STARTED') return
    const token = randomUUID()
    const claim = await this.acceptance.store.change(state, (s) => {
      const now = this.acceptance.clock.now()
      const intent = s.combatIntent
      if (
        intent === null ||
        intent.phase === 'STARTED' ||
        (intent.leaseUntil !== null && new Date(intent.leaseUntil) > now)
      )
        return null
      intent.leaseToken = token
      intent.leaseUntil = new Date(now.getTime() + 30_000).toISOString()
      intent.attempts++
      return structuredClone(s)
    })
    if (claim?.combatIntent == null) return
    try {
      let intent = claim.combatIntent
      if (intent.phase === 'PREPARE_PENDING') {
        const receipt = await this.administration.prepare(
          id,
          encounterId,
          'tournament-worker',
          intent.prepareOperationId,
        )
        const prepared = await this.acceptance.store.change(state, (s) => {
          if (s.combatIntent?.leaseToken !== token) return null
          s.combatIntent.roomId = receipt.battleId
          s.combatIntent.phase = 'START_PENDING'
          s.blocker = null
          return structuredClone(s.combatIntent)
        })
        if (prepared === null) return
        intent = prepared
      }
      await this.administration.start(id, encounterId, 'tournament-worker', intent.startOperationId)
      await this.acceptance.store.change(state, (s) => {
        if (s.combatIntent?.leaseToken !== token) return
        s.combatIntent.phase = 'STARTED'
        s.combatIntent.leaseToken = null
        s.combatIntent.leaseUntil = null
        s.blocker = null
      })
    } catch (error: unknown) {
      await this.acceptance.store.change(state, (s) => {
        if (s.combatIntent?.leaseToken !== token) return
        s.combatIntent.leaseToken = null
        s.combatIntent.leaseUntil = null
        s.blocker = {
          since: this.acceptance.clock.now().toISOString(),
          code: error instanceof RegistrationError ? error.code : 'COMBAT_PENDING',
          message:
            'No se pudo confirmar la operación de Combat. Se conserva la misma sala e intención para recuperar.',
          responsible: 'COMBAT_OPERATIONS',
        }
      })
    }
  }
}
