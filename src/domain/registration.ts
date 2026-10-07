import type { PublishedBracket } from './bracket'
import type { RoundWindow, ACCEPTANCE_POLICY } from './match-acceptance'

export const CONTRACT_VERSION = 'torneos-hu77-84-78-hu83-v2.0.0'
export const MODALITIES_CONTRACT_VERSION = 'torneos-v3.0.0'
export type TournamentMode = 'SOLO' | 'DUO' | 'TRIO'
export type TeamSize = 1 | 2 | 3
export const modeSize = (mode: TournamentMode): TeamSize =>
  mode === 'SOLO' ? 1 : mode === 'DUO' ? 2 : 3
export interface RegistrationMember {
  subject: string
  position: number
  consentAt: string | null
  consentVersion: string | null
}
export const CALENDAR_DISTANCE_MS = 91 * 24 * 60 * 60 * 1000
export type PaymentMethod = 'CREDITS' | 'SIMULATED_MONEY'
export interface CreditMethod {
  method: 'CREDITS'
  amount: number
}
export interface MoneyMethod {
  method: 'SIMULATED_MONEY'
  amountMinor: number
  currency: string
  minorUnit: number
}
export type EntryPolicy =
  | { version: 1; free: true; methods: [] }
  | { version: 1; free: false; methods: (CreditMethod | MoneyMethod)[] }
export interface TeamAvatar {
  kind: 'ACCOUNT_AVATAR'
  subject: string
}
export interface Failure {
  code: string
  message: string
  status: number
}
export type TeamStatus =
  | 'AWAITING_CONSENT'
  | 'PENDING_PAYMENT'
  | 'PAYMENT_PENDING'
  | 'COMPENSATING'
  | 'CONFIRMED'
  | 'CANCELLED'
export interface RegistrationReceipt {
  id: string
  kind: 'TEAM_REGISTRATION'
  tournamentId: string
  teamId: string
  memberIds: string[]
  registeredAt: string
  status: 'REGISTERED'
}
export type EntryPayment = { payerId: string; realMoneyMoved: false } & (
  | { method: 'FREE'; amount: 0; chargeId: null }
  | { method: 'CREDITS'; amount: number; chargeId: string }
  | {
      method: 'SIMULATED_MONEY'
      amountMinor: number
      currency: string
      minorUnit: number
      chargeId: string
      reference: string
      maskedCard: string
      simulated: true
    }
)
export interface EntryReceipt {
  id: string
  kind: 'ENTRY_CONFIRMATION'
  tournamentId: string
  teamId: string
  slot: number
  confirmedAt: string
  payment: EntryPayment
}
export interface RegistrationTeam {
  id: string
  name: string
  avatar: TeamAvatar
  ownerId: string
  companionId: string | null
  members?: RegistrationMember[]
  status: TeamStatus
  createdAt: string
  ownerConsentAt: string
  ownerConsentVersion: string
  identityPolicyVersion: string
  consentAt: string | null
  consentVersion: string | null
  slot: number | null
  paymentOperationId: string | null
  chargeId: string | null
  confirmedAt: string | null
  failure: Failure | null
  registrationReceipt: RegistrationReceipt
  entryReceipt: EntryReceipt | null
}
export interface RegistrationOperation {
  intent: string
  teamId: string
  method?: PaymentMethod | 'FREE'
  error?: Failure
  simulated?: {
    approved: boolean
    reference: string | null
    maskedCard: string
    declineReason: string | null
  }
}
export interface RegistrationTournament {
  acceptancePolicy?: typeof ACCEPTANCE_POLICY | null
  roundWindows?: RoundWindow[]
  tournamentMode?: TournamentMode
  teamSize?: TeamSize
  contractVersion?: string
  id: string
  name: string
  entryPolicy: EntryPolicy
  entryFee: number | null
  opensAt: string
  closesAt: string
  startsAt: string
  bracket: PublishedBracket | null
  teams: RegistrationTeam[]
  operations: Record<string, RegistrationOperation>
}
export class RegistrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422,
  ) {
    super(message)
  }
}
export const requireRule: (
  condition: boolean,
  code: string,
  message: string,
  status?: number,
) => asserts condition = (condition, code, message, status = 422) => {
  if (!condition) throw new RegistrationError(code, message, status)
}
export const registrationOpen = (t: RegistrationTournament, now: Date): boolean =>
  t.bracket === null && new Date(t.opensAt) <= now && now < new Date(t.closesAt)
/** Compatibilidad de datos: nunca cambia recibos ni huellas de operaciones v2. */
export const teamMembers = (team: RegistrationTeam): RegistrationMember[] =>
  team.members ?? [
    {
      subject: team.ownerId,
      position: 0,
      consentAt: team.ownerConsentAt,
      consentVersion: team.ownerConsentVersion,
    },
    ...(team.companionId === null
      ? []
      : [
          {
            subject: team.companionId,
            position: 1,
            consentAt: team.consentAt,
            consentVersion: team.consentVersion,
          },
        ]),
  ]
export const teamMemberIds = (team: RegistrationTeam): string[] =>
  teamMembers(team).map((member) => member.subject)
export const teamConsented = (team: RegistrationTeam, size: number): boolean => {
  const members = teamMembers(team)
  return (
    members.length === size &&
    new Set(members.map((m) => m.subject)).size === size &&
    members.every(
      (m, i) =>
        m.position === i &&
        m.subject.trim().length > 0 &&
        m.consentAt !== null &&
        ['team-registration-v2', 'team-registration-v3'].includes(m.consentVersion ?? ''),
    )
  )
}
export const memberOf = (team: RegistrationTeam, subject: string): boolean =>
  teamMemberIds(team).includes(subject)
export const validateOperation = (id: string): void => {
  requireRule(
    typeof id === 'string' && id.trim().length > 0 && id.length <= 100,
    'INVALID_OPERATION',
    'El identificador de operación debe tener entre 1 y 100 caracteres.',
  )
}
export const normalizeName = (name: string): string => name.trim().replace(/\s+/gu, ' ')
export const saveOperation = (
  t: RegistrationTournament,
  id: string,
  op: RegistrationOperation,
): void => {
  Object.defineProperty(t.operations, id, {
    value: op,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}
export const getOperation = (
  t: RegistrationTournament,
  id: string,
): RegistrationOperation | undefined =>
  Object.hasOwn(t.operations, id) ? t.operations[id] : undefined
export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const only = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key))
export const validateEntryPolicy = (value: unknown): EntryPolicy => {
  requireRule(
    record(value) &&
      only(value, ['version', 'free', 'methods']) &&
      value.version === 1 &&
      typeof value.free === 'boolean' &&
      Array.isArray(value.methods),
    'INVALID_CONFIGURATION',
    'Revisa la política de inscripción.',
  )
  if (value.free) {
    requireRule(
      value.methods.length === 0,
      'INVALID_CONFIGURATION',
      'Un torneo gratuito no admite métodos de pago.',
    )
    return { version: 1, free: true, methods: [] }
  }
  requireRule(
    value.methods.length >= 1 && value.methods.length <= 2,
    'INVALID_CONFIGURATION',
    'Configura uno o dos métodos sin duplicarlos.',
  )
  const seen = new Set<string>()
  const methods = value.methods.map((item: unknown): CreditMethod | MoneyMethod => {
    requireRule(
      record(item) && typeof item.method === 'string' && !seen.has(item.method),
      'INVALID_CONFIGURATION',
      'El método es inválido o está duplicado.',
    )
    seen.add(item.method)
    if (item.method === 'CREDITS') {
      requireRule(
        only(item, ['method', 'amount']) &&
          Number.isSafeInteger(item.amount) &&
          Number(item.amount) > 0,
        'INVALID_CONFIGURATION',
        'El importe en créditos debe ser entero positivo.',
      )
      return { method: 'CREDITS', amount: Number(item.amount) }
    }
    requireRule(
      item.method === 'SIMULATED_MONEY' &&
        only(item, ['method', 'amountMinor', 'currency', 'minorUnit']) &&
        Number.isSafeInteger(item.amountMinor) &&
        Number(item.amountMinor) > 0 &&
        typeof item.currency === 'string' &&
        /^[A-Z]{3}$/u.test(item.currency) &&
        Number.isInteger(item.minorUnit) &&
        Number(item.minorUnit) >= 0 &&
        Number(item.minorUnit) <= 6,
      'INVALID_CONFIGURATION',
      'Configura importe, moneda y precisión del pago simulado.',
    )
    return {
      method: 'SIMULATED_MONEY',
      amountMinor: Number(item.amountMinor),
      currency: item.currency,
      minorUnit: Number(item.minorUnit),
    }
  })
  return { version: 1, free: false, methods }
}
export const entryFeeProjection = (policy: EntryPolicy): number | null =>
  policy.free
    ? 0
    : (policy.methods.find((m): m is CreditMethod => m.method === 'CREDITS')?.amount ?? null)
export const publicTournament = (t: RegistrationTournament, now: Date) => ({
  acceptancePolicy: t.acceptancePolicy ?? null,
  roundSchedule: t.roundWindows ?? [],
  serverNow: now.toISOString(),
  contractVersion: t.contractVersion ?? CONTRACT_VERSION,
  tournamentMode: t.tournamentMode ?? 'DUO',
  teamSize: t.teamSize ?? 2,
  id: t.id,
  name: t.name,
  entryPolicy: t.entryPolicy,
  entryFee: t.entryFee,
  opensAt: t.opensAt,
  closesAt: t.closesAt,
  startsAt: t.startsAt,
  bracketPublished: t.bracket !== null,
  open: registrationOpen(t, now),
})
export const publicTeam = (tournamentId: string, team: RegistrationTeam) => ({
  id: team.id,
  tournamentId,
  name: team.name,
  avatar: team.avatar,
  ownerId: team.ownerId,
  companionId: teamMemberIds(team)[1] ?? null,
  members: teamMembers(team),
  status: team.status,
  createdAt: team.createdAt,
  consentAt: team.consentAt,
  consentVersion: team.consentVersion,
  slot: team.slot,
  confirmedAt: team.confirmedAt,
  registrationReceipt: team.registrationReceipt,
  entryReceipt: team.entryReceipt,
  failure:
    team.failure === null ? null : { code: team.failure.code, message: team.failure.message },
})
