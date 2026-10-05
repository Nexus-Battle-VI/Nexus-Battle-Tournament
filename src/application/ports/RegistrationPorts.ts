import type { RegistrationTournament, TeamAvatar } from '../../domain/registration'
export interface RegistrationRepository {
  list(): Promise<RegistrationTournament[]>
  create(
    tournament: RegistrationTournament,
    operationId: string,
    intent: string,
  ): Promise<RegistrationTournament>
  read(id: string): Promise<RegistrationTournament>
  change<T>(id: string, action: (tournament: RegistrationTournament) => T): Promise<T>
}
export interface TournamentAccounts {
  eligible(subject: string): Promise<boolean>
  validateIdentity(
    name: string,
    avatarSubject: string,
  ): Promise<{
    name: string
    avatar: TeamAvatar
    policyVersion: 'account-team-identity-v1'
  }>
}
export interface EntryCharge {
  operationId: string
  tournamentId: string
  teamId: string
  payerId: string
  amount: number
}
export interface EntryChargeResult extends EntryCharge {
  chargeId: string
  status: 'CHARGED' | 'REFUNDED'
  applied: boolean
}
export interface TournamentWallet {
  charge(command: EntryCharge): Promise<EntryChargeResult>
  refund(chargeId: string, operationId: string): Promise<EntryChargeResult>
}
export interface SimulatedCard {
  holder: string
  number: string
  expiry: string
  securityCode: string
}
export interface SimulatedDecision {
  approved: boolean
  reference: string | null
  maskedCard: string
  declineReason: string | null
}
/** Decisión pura, sin red: debe ejecutarse dentro de la transacción de inscripción. */
export interface SimulatedEntryPayment {
  decide(transactionId: string, card: SimulatedCard): SimulatedDecision
}
