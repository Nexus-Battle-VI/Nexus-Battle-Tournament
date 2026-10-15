import {
  getOperation,
  publicTournament,
  RegistrationError,
  requireRule,
  validateOperation,
  type RegistrationTournament,
} from '../../domain/registration'
import { INACTIVITY_TIMEOUT_MS, type EntryRefund } from '../../domain/tournament-closure'
import type { ClockPort } from '../ports/ClockPort'
import type { LifecycleRepository } from '../ports/LifecyclePorts'
import type { RegistrationRepository, TournamentWallet } from '../ports/RegistrationPorts'
import { validWalletResult } from './Registrations'

export const TOURNAMENT_CLOSURES = Symbol('TournamentClosures')
const activityAt = (t: RegistrationTournament): string =>
  new Date(
    Math.max(new Date(t.startsAt).getTime(), new Date(t.lastActivityAt ?? t.startsAt).getTime()),
  ).toISOString()

/** Primero persiste el cierre y las intenciones; Wallet se llama fuera de SQL. */
export class TournamentClosures {
  constructor(
    private readonly tournaments: RegistrationRepository,
    private readonly lifecycle: LifecycleRepository,
    private readonly wallet: TournamentWallet,
    private readonly clock: ClockPort,
  ) {}
  async isClosed(id: string): Promise<boolean> {
    return (await this.tournaments.read(id)).closure != null
  }

  async close(
    id: string,
    actor: string,
    operationId: string,
    reason: 'INACTIVITY' | 'ADMINISTRATIVE' = 'ADMINISTRATIVE',
  ) {
    validateOperation(operationId)
    const state = await this.lifecycle.read(id)
    requireRule(state.champion === null, 'TOURNAMENT_COMPLETED', 'El torneo ya tiene campeón.', 409)
    await this.tournaments.change(id, (t) => {
      if (t.closure != null) {
        requireRule(
          t.closure.operationId !== operationId ||
            (t.closure.actor === actor && t.closure.reason === reason),
          'OPERATION_CONFLICT',
          'El identificador corresponde a otro cierre.',
          409,
        )
        return
      }
      const now = this.clock.now()
      const lastActivityAt = activityAt(t)
      if (reason === 'INACTIVITY')
        requireRule(
          now.getTime() - new Date(lastActivityAt).getTime() >= INACTIVITY_TIMEOUT_MS,
          'TOURNAMENT_STILL_ACTIVE',
          'El torneo no lleva treinta minutos sin actividad.',
          409,
        )
      t.closure = {
        operationId,
        reason,
        actor,
        closedAt: now.toISOString(),
        lastActivityAt,
        refunds: this.refunds(t),
      }
    })
    await this.refund(id)
    return publicTournament(await this.tournaments.read(id), this.clock.now())
  }

  private refunds(t: RegistrationTournament): EntryRefund[] {
    return t.teams.flatMap((team): EntryRefund[] => {
      const payment = team.entryReceipt?.payment
      const op =
        team.paymentOperationId === null ? undefined : getOperation(t, team.paymentOperationId)
      const method = payment?.method ?? op?.method
      if (
        team.paymentOperationId === null ||
        (method !== 'CREDITS' && method !== 'SIMULATED_MONEY') ||
        (payment === undefined && !['PAYMENT_PENDING', 'COMPENSATING'].includes(team.status))
      )
        return []
      const configured = t.entryPolicy.methods.find((m) => m.method === method)
      const amount =
        payment?.method === 'CREDITS'
          ? payment.amount
          : payment?.method === 'SIMULATED_MONEY'
            ? payment.amountMinor
            : configured?.method === 'CREDITS'
              ? configured.amount
              : 0
      requireRule(
        amount > 0,
        'INVALID_ENTRY_REFUND',
        'Falta el importe original de la inscripción.',
        409,
      )
      const root = `entry:${team.id}:${team.paymentOperationId}`
      return [
        {
          teamId: team.id,
          payerId: payment?.payerId ?? team.ownerId,
          operationId: `${root}:refund`,
          chargeOperationId: `${root}:charge`,
          method,
          amount,
          chargeId: payment?.chargeId ?? team.chargeId,
          status: 'PENDING',
          refundedAt: null,
          lastError: null,
          receipt: null,
        },
      ]
    })
  }

  async refund(id: string): Promise<void> {
    const tournament = await this.tournaments.read(id)
    for (const line of tournament.closure?.refunds ?? []) {
      if (line.status === 'REFUNDED') continue
      try {
        let receipt: EntryRefund['receipt']
        if (line.method === 'SIMULATED_MONEY') {
          const payment = tournament.teams.find((t) => t.id === line.teamId)?.entryReceipt?.payment
          requireRule(
            payment?.method === 'SIMULATED_MONEY',
            'INVALID_ENTRY_REFUND',
            'Falta el recibo simulado.',
            409,
          )
          receipt = payment
        } else {
          const charge = {
            operationId: line.chargeOperationId,
            tournamentId: id,
            teamId: line.teamId,
            payerId: line.payerId,
            amount: line.amount,
          }
          let chargeId = line.chargeId
          if (chargeId === null) {
            // Recupera exactamente el cobro ya intentado, incluso si se perdió su respuesta.
            const recovered = await this.wallet.charge(charge)
            requireRule(
              validWalletResult(recovered, charge),
              'WALLET_PROTOCOL_ERROR',
              'El cobro no coincide con su intención.',
              503,
            )
            chargeId = recovered.chargeId
            await this.tournaments.change(id, (t) => {
              const saved = t.closure?.refunds.find((r) => r.teamId === line.teamId)
              if (saved?.status === 'PENDING') saved.chargeId = chargeId
            })
          }
          const refunded = await this.wallet.refund(chargeId, line.operationId)
          requireRule(
            validWalletResult(refunded, { ...charge, operationId: line.operationId }, chargeId) &&
              refunded.status === 'REFUNDED',
            'WALLET_PROTOCOL_ERROR',
            'Wallet no confirmó la devolución original.',
            503,
          )
          receipt = refunded
        }
        await this.tournaments.change(id, (t) => {
          const saved = t.closure?.refunds.find((r) => r.teamId === line.teamId)
          if (saved?.status !== 'PENDING') return
          saved.status = 'REFUNDED'
          saved.refundedAt = this.clock.now().toISOString()
          saved.lastError = null
          saved.receipt = receipt
        })
      } catch (error: unknown) {
        await this.tournaments.change(id, (t) => {
          const saved = t.closure?.refunds.find((r) => r.teamId === line.teamId)
          if (saved?.status === 'PENDING')
            saved.lastError = error instanceof RegistrationError ? error.code : 'REFUND_PENDING'
        })
      }
    }
  }

  async sweep(): Promise<void> {
    for (const t of await this.tournaments.list()) {
      try {
        if (t.closure != null) await this.refund(t.id)
        else if (
          this.clock.now().getTime() - new Date(activityAt(t)).getTime() >=
          INACTIVITY_TIMEOUT_MS
        )
          await this.close(t.id, 'tournament-worker', `inactivity:${t.id}`, 'INACTIVITY')
      } catch {
        // Otro worker, una final confirmada o Wallet pendiente conservan el estado durable.
      }
    }
  }
}
