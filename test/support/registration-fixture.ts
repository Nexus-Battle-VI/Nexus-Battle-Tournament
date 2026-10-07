import { Registrations } from '../../src/application/use-cases/Registrations'
import { Brackets } from '../../src/application/use-cases/Brackets'
import type {
  RegistrationRepository,
  TournamentAccounts,
  TournamentWallet,
  EntryCharge,
  EntryChargeResult,
} from '../../src/application/ports/RegistrationPorts'
import {
  RegistrationError,
  normalizeName,
  type EntryPolicy,
  type TournamentMode,
} from '../../src/domain/registration'
import { InMemoryRegistrationRepository } from '../../src/adapters/outbound/persistence/InMemoryRegistrationRepository'
import { InMemoryTournamentEncounterRepository } from '../../src/adapters/outbound/persistence/InMemoryTournamentEncounterRepository'
import { SimulatedEntryGateway } from '../../src/adapters/outbound/payment/SimulatedEntryGateway'
/** Dobles explícitos: no acreditan sesiones Account ni ledger Wallet reales. */
export class TestWallet implements TournamentWallet {
  readonly charges = new Map<string, EntryChargeResult | 'REJECTED'>()
  readonly balances = new Map<string, number>()
  debits = 0
  refunds = 0
  uncertainCharge = false
  uncertainRefund = false
  afterCharge?: () => void
  charge(command: EntryCharge): Promise<EntryChargeResult> {
    const saved = this.charges.get(command.operationId)
    if (saved === 'REJECTED')
      throw new RegistrationError('INSUFFICIENT_BALANCE', 'Saldo insuficiente.', 422)
    if (saved !== undefined) return Promise.resolve({ ...saved, applied: false })
    const available = this.balances.get(command.payerId) ?? 120
    if (available < command.amount) {
      this.charges.set(command.operationId, 'REJECTED')
      throw new RegistrationError('INSUFFICIENT_BALANCE', 'Saldo insuficiente.', 422)
    }
    this.balances.set(command.payerId, available - command.amount)
    this.debits += 1
    const result: EntryChargeResult = {
      ...command,
      chargeId: 'wallet:' + command.operationId,
      status: 'CHARGED',
      applied: true,
    }
    this.charges.set(command.operationId, result)
    this.afterCharge?.()
    if (this.uncertainCharge) {
      this.uncertainCharge = false
      throw new Error('Timeout después de débito')
    }
    return Promise.resolve(result)
  }
  refund(chargeId: string, operationId: string): Promise<EntryChargeResult> {
    const entry = [...this.charges.entries()].find(
      ([, value]) => value !== 'REJECTED' && value.chargeId === chargeId,
    )
    if (entry === undefined || entry[1] === 'REJECTED') throw new Error('No existe el cobro')
    const [key, saved] = entry
    const applied = saved.status !== 'REFUNDED'
    if (applied) {
      this.refunds += 1
      this.balances.set(saved.payerId, (this.balances.get(saved.payerId) ?? 0) + saved.amount)
      this.charges.set(key, { ...saved, status: 'REFUNDED' })
    }
    if (this.uncertainRefund) {
      this.uncertainRefund = false
      throw new Error('Timeout después de devolver')
    }
    return Promise.resolve({ ...saved, operationId, status: 'REFUNDED', applied })
  }
}
export const CREDIT_POLICY: EntryPolicy = {
  version: 1,
  free: false,
  methods: [{ method: 'CREDITS', amount: 100 }],
}
export const MIXED_POLICY: EntryPolicy = {
  version: 1,
  free: false,
  methods: [
    { method: 'CREDITS', amount: 100 },
    { method: 'SIMULATED_MONEY', amountMinor: 250050, currency: 'COP', minorUnit: 2 },
  ],
}
export const FREE_POLICY: EntryPolicy = { version: 1, free: true, methods: [] }
export const CARD = {
  holder: 'Prueba local',
  number: '4111111111111111',
  expiry: '12/29',
  securityCode: '739',
}
export const fixture = (
  repository?: RegistrationRepository,
  policy: EntryPolicy = CREDIT_POLICY,
) => {
  const encounters = new InMemoryTournamentEncounterRepository()
  const repo = repository ?? new InMemoryRegistrationRepository(encounters)
  const accounts: jest.Mocked<TournamentAccounts> = {
    eligible: jest.fn((subject: string) =>
      Promise.resolve(!['missing', 'inactive'].includes(subject)),
    ),
    validateIdentity: jest.fn((name: string, subject: string) =>
      Promise.resolve({
        name: normalizeName(name),
        avatar: { kind: 'ACCOUNT_AVATAR' as const, subject },
        policyVersion: 'account-team-identity-v1' as const,
      }),
    ),
  }
  const wallet = new TestWallet()
  let now = new Date('2026-10-05T12:00:00Z')
  const clock = { now: () => now }
  const simulator = new SimulatedEntryGateway()
  const registrations = new Registrations(repo, accounts, wallet, clock, simulator)
  const brackets = new Brackets(repo, clock)
  const create = (tournamentMode?: TournamentMode) =>
    registrations.create('admin', {
      operationId: 'create',
      ...(tournamentMode === undefined ? {} : { tournamentMode }),
      name: 'Torneo de prueba',
      entryPolicy: policy,
      opensAt: '2026-10-01T00:00:00Z',
      closesAt: '2026-10-10T00:00:00Z',
      startsAt: '2026-10-12T00:00:00Z',
    })
  const register = (id: string, n = 0) =>
    registrations.register(id, 'p' + String(n), {
      operationId: 'register' + String(n),
      name: 'Equipo ' + String(n),
      companionId: 'q' + String(n),
      avatar: { kind: 'ACCOUNT_AVATAR', subject: 'p' + String(n) },
    })
  const accept = async (id: string, n = 0) => {
    const team = await register(id, n)
    return registrations.consent(id, team.id, 'q' + String(n), 'consent' + String(n), true)
  }
  const confirm = async (id: string, n = 0) => {
    const team = await accept(id, n)
    return registrations.enter(id, team.id, 'p' + String(n), { operationId: 'pay' + String(n) })
  }
  return {
    repo,
    accounts,
    wallet,
    clock,
    simulator,
    registrations,
    brackets,
    encounters,
    create,
    register,
    accept,
    confirm,
    setNow: (date: string) => {
      now = new Date(date)
    },
  }
}
