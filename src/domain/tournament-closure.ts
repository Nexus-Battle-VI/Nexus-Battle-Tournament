import type { EntryPayment } from './registration'
import type { EntryChargeResult } from '../application/ports/RegistrationPorts'

export const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000
export interface EntryRefund {
  teamId: string
  payerId: string
  operationId: string
  chargeOperationId: string
  method: 'CREDITS' | 'SIMULATED_MONEY'
  amount: number
  chargeId: string | null
  status: 'PENDING' | 'REFUNDED'
  refundedAt: string | null
  lastError: string | null
  receipt: EntryChargeResult | EntryPayment | null
}
export interface TournamentClosure {
  operationId: string
  reason: 'INACTIVITY' | 'ADMINISTRATIVE'
  actor: string
  closedAt: string
  lastActivityAt: string
  refunds: EntryRefund[]
}
export const publicClosure = (closure: TournamentClosure | null | undefined) =>
  closure == null
    ? null
    : {
        reason: closure.reason,
        closedAt: closure.closedAt,
        refundStatus: closure.refunds.some((r) => r.status === 'PENDING')
          ? ('PENDING' as const)
          : ('COMPLETE' as const),
        refundedCount: closure.refunds.filter((r) => r.status === 'REFUNDED').length,
        pendingCount: closure.refunds.filter((r) => r.status === 'PENDING').length,
      }
