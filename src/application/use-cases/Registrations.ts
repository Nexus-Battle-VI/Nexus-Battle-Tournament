import { randomUUID } from 'node:crypto'
import { roundWindows, ACCEPTANCE_POLICY } from '../../domain/match-acceptance'
import {
  RegistrationError,
  memberOf,
  registrationOpen,
  requireRule,
  validateOperation,
  normalizeName,
  getOperation,
  saveOperation,
  validateEntryPolicy,
  entryFeeProjection,
  publicTournament,
  publicTeam,
  record,
  modeSize,
  teamMemberIds,
  teamMembers,
  teamConsented,
  CONTRACT_VERSION,
  MODALITIES_CONTRACT_VERSION,
  type TournamentMode,
  type RegistrationTeam,
  type RegistrationTournament,
  type TeamAvatar,
  type EntryPayment,
  type Failure,
  type PaymentMethod,
  type EntryPolicy,
} from '../../domain/registration'
import type { ClockPort } from '../ports/ClockPort'
import type {
  RegistrationRepository,
  TournamentAccounts,
  TournamentWallet,
  EntryChargeResult,
  SimulatedEntryPayment,
  SimulatedCard,
  EntryCharge,
} from '../ports/RegistrationPorts'

export const REGISTRATIONS = Symbol('Registrations')
const failure = (code: string, message: string, status = 503): Failure => ({
  code,
  message,
  status,
})
const throwFailure = (value: Failure): never => {
  throw new RegistrationError(value.code, value.message, value.status)
}
const validWalletResult = (
  value: unknown,
  expected: EntryCharge,
  chargeId?: string,
): value is EntryChargeResult =>
  record(value) &&
  typeof value.chargeId === 'string' &&
  value.chargeId.length > 0 &&
  (chargeId === undefined || chargeId === value.chargeId) &&
  (value.status === 'CHARGED' || value.status === 'REFUNDED') &&
  typeof value.applied === 'boolean' &&
  value.operationId === expected.operationId &&
  value.tournamentId === expected.tournamentId &&
  value.teamId === expected.teamId &&
  value.payerId === expected.payerId &&
  value.amount === expected.amount

export interface CreateTournament {
  tournamentMode?: TournamentMode
  operationId: string
  name: string
  opensAt: string
  closesAt: string
  startsAt: string
  entryPolicy?: unknown
  entryFee?: number
}
export interface RegisterTeam {
  operationId: string
  name: string
  avatar: TeamAvatar
  companionId?: string
  invitedMemberIds?: string[]
}
export interface EnterTeam {
  operationId: string
  method?: PaymentMethod
  card?: SimulatedCard
}

export class Registrations {
  constructor(
    readonly repository: RegistrationRepository,
    private readonly accounts: TournamentAccounts,
    private readonly wallet: TournamentWallet,
    private readonly clock: ClockPort,
    private readonly simulator: SimulatedEntryPayment,
  ) {}

  private async eligible(...subjects: string[]): Promise<void> {
    const results = await Promise.all(subjects.map((s) => this.accounts.eligible(s)))
    requireRule(
      results.every(Boolean),
      'INVALID_PLAYER',
      'Todos los integrantes deben tener una cuenta de jugador activa.',
    )
  }
  private team(t: RegistrationTournament, teamId: string): RegistrationTeam {
    const team = t.teams.find((x) => x.id === teamId)
    requireRule(team !== undefined, 'TEAM_NOT_FOUND', 'El equipo no existe.', 404)
    return team
  }
  private replay(
    t: RegistrationTournament,
    operationId: string,
    intent: string,
  ): RegistrationTeam | undefined {
    const op = getOperation(t, operationId)
    if (op === undefined) return undefined
    requireRule(
      op.intent === intent,
      'OPERATION_CONFLICT',
      'El identificador corresponde a otra intención.',
      409,
    )
    if (op.error !== undefined) throwFailure(op.error)
    return this.team(t, op.teamId)
  }
  async create(subject: string, command: CreateTournament) {
    validateOperation(command.operationId)
    requireRule(
      command.tournamentMode === undefined ||
        ['SOLO', 'DUO', 'TRIO'].includes(command.tournamentMode),
      'INVALID_MODALITY',
      'La modalidad debe ser SOLO, DUO o TRIO.',
    )
    requireRule(
      (command.entryPolicy === undefined) !== (command.entryFee === undefined),
      'INVALID_CONFIGURATION',
      'Envía entryPolicy o entryFee de compatibilidad, exclusivamente.',
    )
    const policy: EntryPolicy =
      command.entryPolicy !== undefined
        ? validateEntryPolicy(command.entryPolicy)
        : validateEntryPolicy(
            command.entryFee === 0
              ? { version: 1, free: true, methods: [] }
              : {
                  version: 1,
                  free: false,
                  methods: [{ method: 'CREDITS', amount: command.entryFee }],
                },
          )
    const dates = [command.opensAt, command.closesAt, command.startsAt]
    requireRule(
      dates.every(
        (value) =>
          typeof value === 'string' &&
          /(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
          Number.isFinite(new Date(value).getTime()),
      ),
      'INVALID_CONFIGURATION',
      'Las fechas deben ser ISO con zona horaria.',
    )
    const [opensAt, closesAt, startsAt] = dates.map((value) => new Date(value).toISOString()) as [
      string,
      string,
      string,
    ]
    const name = command.name.trim()
    requireRule(
      name.length > 0 && name.length <= 100 && opensAt < closesAt && closesAt <= startsAt,
      'INVALID_CONFIGURATION',
      'Revisa nombre y orden de las fechas.',
    )
    // No añadir modalidad a las huellas v2: sus replays ya están persistidos.
    const intent = JSON.stringify([
      'create',
      subject,
      name,
      policy,
      opensAt,
      closesAt,
      startsAt,
      ...(command.tournamentMode === undefined ? [] : [command.tournamentMode]),
    ])
    const t = await this.repository.create(
      {
        id: randomUUID(),
        acceptancePolicy: command.tournamentMode === undefined ? null : ACCEPTANCE_POLICY,
        roundWindows: command.tournamentMode === undefined ? [] : roundWindows(startsAt),
        tournamentMode: command.tournamentMode ?? 'DUO',
        teamSize: modeSize(command.tournamentMode ?? 'DUO'),
        contractVersion:
          command.tournamentMode === undefined ? CONTRACT_VERSION : MODALITIES_CONTRACT_VERSION,
        name,
        entryPolicy: policy,
        entryFee: entryFeeProjection(policy),
        opensAt,
        closesAt,
        startsAt,
        bracket: null,
        teams: [],
        operations: {},
      },
      command.operationId,
      intent,
    )
    return publicTournament(t, this.clock.now())
  }
  async register(id: string, subject: string, input: RegisterTeam): Promise<RegistrationTeam> {
    validateOperation(input.operationId)
    const existing = await this.repository.read(id)
    const size = existing.teamSize ?? 2
    const legacy = input.invitedMemberIds === undefined && input.companionId !== undefined
    requireRule(
      legacy
        ? size === 2
        : input.companionId === undefined && Array.isArray(input.invitedMemberIds),
      'INVALID_ROSTER',
      'Usa companionId solo para DUO, o invitedMemberIds para la modalidad configurada.',
    )
    const ids = [subject, ...(legacy ? [input.companionId ?? ''] : (input.invitedMemberIds ?? []))]
    requireRule(
      ids.length === size &&
        new Set(ids).size === size &&
        ids.every((s) => typeof s === 'string' && s.trim().length > 0 && s.length <= 200),
      'INVALID_PLAYER',
      'El equipo debe tener el tamaño exacto y jugadores distintos.',
    )
    requireRule(
      ids.includes(input.avatar.subject),
      'INVALID_TEAM_AVATAR',
      'El avatar debe pertenecer a uno de los integrantes.',
    )
    const normalized = normalizeName(input.name)
    const intent = JSON.stringify([
      'register',
      subject,
      normalized,
      input.avatar.subject,
      legacy ? input.companionId : input.invitedMemberIds,
    ])
    const previous = this.replay(existing, input.operationId, intent)
    if (previous !== undefined) return previous
    await this.eligible(...ids)
    const identity = await this.accounts.validateIdentity(input.name, input.avatar.subject)
    requireRule(
      identity.name === normalized && identity.avatar.subject === input.avatar.subject,
      'SERVICE_UNAVAILABLE',
      'Account devolvió una identidad incompatible.',
      503,
    )
    return this.repository.change(id, (t) => {
      const replay = this.replay(t, input.operationId, intent)
      if (replay !== undefined) return replay
      requireRule(
        registrationOpen(t, this.clock.now()),
        'REGISTRATION_CLOSED',
        'La inscripción no está abierta.',
        409,
      )
      requireRule(
        !t.teams.some((team) => team.status !== 'CANCELLED' && ids.some((s) => memberOf(team, s))),
        'ALREADY_REGISTERED',
        'Uno de los integrantes ya pertenece a un equipo activo.',
        409,
      )
      const teamId = randomUUID()
      const now = this.clock.now().toISOString()
      const team: RegistrationTeam = {
        id: teamId,
        name: identity.name,
        avatar: identity.avatar,
        ownerId: subject,
        companionId: size === 2 ? (ids[1] ?? null) : null,
        members: ids.map((player, position) => ({
          subject: player,
          position,
          consentAt: position === 0 ? now : null,
          consentVersion:
            position === 0 ? (legacy ? 'team-registration-v2' : 'team-registration-v3') : null,
        })),
        status: size === 1 ? 'PENDING_PAYMENT' : 'AWAITING_CONSENT',
        createdAt: now,
        ownerConsentAt: now,
        ownerConsentVersion: legacy ? 'team-registration-v2' : 'team-registration-v3',
        identityPolicyVersion: identity.policyVersion,
        consentAt: size === 1 ? now : null,
        consentVersion: size === 1 ? 'team-registration-v3' : null,
        slot: null,
        paymentOperationId: null,
        chargeId: null,
        confirmedAt: null,
        failure: null,
        registrationReceipt: {
          id: 'registration:' + teamId,
          kind: 'TEAM_REGISTRATION',
          tournamentId: id,
          teamId,
          memberIds: ids,
          registeredAt: now,
          status: 'REGISTERED',
        },
        entryReceipt: null,
      }
      t.teams.push(team)
      saveOperation(t, input.operationId, { intent, teamId })
      return team
    })
  }
  async consent(
    id: string,
    teamId: string,
    subject: string,
    operationId: string,
    accept: boolean,
  ): Promise<RegistrationTeam> {
    validateOperation(operationId)
    const t = await this.repository.read(id)
    const team = this.team(t, teamId)
    requireRule(
      memberOf(team, subject) && team.ownerId !== subject,
      'FORBIDDEN',
      'Solo un integrante invitado puede aceptar o rechazar.',
      403,
    )
    const intent = JSON.stringify(['consent', subject, teamId, accept])
    const previous = this.replay(t, operationId, intent)
    if (previous !== undefined) return previous
    if (accept) await this.eligible(...teamMemberIds(team))
    return this.repository.change(id, (current) => {
      const replay = this.replay(current, operationId, intent)
      if (replay !== undefined) return replay
      const target = this.team(current, teamId)
      requireRule(
        target.status === 'AWAITING_CONSENT',
        'INVALID_TEAM_STATE',
        'El registro ya no espera consentimiento.',
        409,
      )
      if (accept)
        requireRule(
          registrationOpen(current, this.clock.now()),
          'REGISTRATION_CLOSED',
          'La inscripción no está abierta.',
          409,
        )
      target.members ??= teamMembers(target)
      const member = target.members.find((m) => m.subject === subject)
      requireRule(member !== undefined, 'FORBIDDEN', 'No perteneces al equipo.', 403)
      member.consentAt = accept ? (member.consentAt ?? this.clock.now().toISOString()) : null
      member.consentVersion = accept ? target.ownerConsentVersion : null
      const complete = accept && teamConsented(target, current.teamSize ?? 2)
      target.status = accept ? (complete ? 'PENDING_PAYMENT' : 'AWAITING_CONSENT') : 'CANCELLED'
      target.consentAt = complete ? this.clock.now().toISOString() : null
      target.consentVersion = complete ? target.ownerConsentVersion : null
      saveOperation(current, operationId, { intent, teamId })
      return target
    })
  }
  cancel(
    id: string,
    teamId: string,
    subject: string,
    operationId: string,
  ): Promise<RegistrationTeam> {
    validateOperation(operationId)
    return this.repository.change(id, (t) => {
      const team = this.team(t, teamId)
      requireRule(
        memberOf(team, subject),
        'FORBIDDEN',
        'Solo los integrantes pueden cancelar.',
        403,
      )
      const intent = JSON.stringify(['cancel', subject, teamId])
      const previous = this.replay(t, operationId, intent)
      if (previous !== undefined) return previous
      requireRule(
        ['AWAITING_CONSENT', 'PENDING_PAYMENT'].includes(team.status),
        'INVALID_TEAM_STATE',
        'No se puede cancelar durante el pago ni después de confirmar.',
        409,
      )
      team.status = 'CANCELLED'
      saveOperation(t, operationId, { intent, teamId })
      return team
    })
  }
  private method(
    policy: EntryPolicy,
    requested: PaymentMethod | undefined,
  ): PaymentMethod | 'FREE' {
    if (policy.free) {
      requireRule(
        requested === undefined,
        'PAYMENT_METHOD_NOT_CONFIGURED',
        'Este torneo es gratuito.',
      )
      return 'FREE'
    }
    const selected =
      requested ??
      (policy.methods.length === 1 && policy.methods[0]?.method === 'CREDITS'
        ? 'CREDITS'
        : undefined)
    requireRule(
      selected !== undefined && policy.methods.some((m) => m.method === selected),
      'PAYMENT_METHOD_NOT_CONFIGURED',
      'Selecciona un método configurado para este torneo.',
    )
    return selected
  }
  private confirm(t: RegistrationTournament, team: RegistrationTeam, payment: EntryPayment): void {
    requireRule(team.slot !== null, 'INVALID_TEAM_STATE', 'No hay una plaza reservada.', 409)
    const now = this.clock.now().toISOString()
    team.status = 'CONFIRMED'
    team.confirmedAt = now
    team.failure = null
    team.entryReceipt = {
      id: 'entry:' + team.id + ':' + String(team.paymentOperationId),
      kind: 'ENTRY_CONFIRMATION',
      tournamentId: t.id,
      teamId: team.id,
      slot: team.slot,
      confirmedAt: now,
      payment,
    }
  }
  async enter(
    id: string,
    teamId: string,
    subject: string,
    input: EnterTeam,
  ): Promise<RegistrationTeam> {
    validateOperation(input.operationId)
    const existing = await this.repository.read(id)
    const team = this.team(existing, teamId)
    requireRule(
      team.ownerId === subject,
      'FORBIDDEN',
      'Solo el creador puede pagar por el equipo.',
      403,
    )
    const op = getOperation(existing, input.operationId)
    const selected =
      op?.method !== undefined && input.method === undefined
        ? op.method
        : this.method(existing.entryPolicy, input.method)
    const intent = JSON.stringify(['entry', subject, teamId, selected])
    if (op !== undefined) {
      this.replay(existing, input.operationId, intent)
    } else {
      requireRule(
        team.status !== 'AWAITING_CONSENT',
        'CONSENT_REQUIRED',
        'El compañero debe aceptar antes del pago.',
        409,
      )
      requireRule(
        team.status === 'PENDING_PAYMENT',
        'INVALID_TEAM_STATE',
        'Ya existe un pago o el equipo no puede confirmarse.',
        409,
      )
      await this.eligible(...teamMemberIds(team))
    }
    if (op === undefined && selected === 'SIMULATED_MONEY')
      requireRule(
        input.card !== undefined,
        'INVALID_CONFIGURATION',
        'Completa los datos del pago simulado.',
      )
    requireRule(
      input.card === undefined || selected === 'SIMULATED_MONEY',
      'PAYMENT_METHOD_NOT_CONFIGURED',
      'Los datos de tarjeta solo corresponden al pago simulado.',
    )
    await this.repository.change(id, (t) => {
      const previous = getOperation(t, input.operationId)
      if (previous !== undefined) {
        requireRule(
          previous.intent === intent,
          'OPERATION_CONFLICT',
          'El identificador corresponde a otra intención.',
          409,
        )
        return
      }
      const target = this.team(t, teamId)
      requireRule(
        target.status === 'PENDING_PAYMENT',
        'INVALID_TEAM_STATE',
        'Ya existe un pago o el equipo no puede confirmarse.',
        409,
      )
      requireRule(
        teamConsented(target, t.teamSize ?? 2),
        'CONSENT_REQUIRED',
        'Todos los integrantes deben consentir antes del pago.',
        409,
      )
      requireRule(
        registrationOpen(t, this.clock.now()),
        'REGISTRATION_CLOSED',
        'La inscripción no está abierta.',
        409,
      )
      const slots = t.teams.flatMap((x) => (x.slot === null ? [] : [x.slot]))
      const slot = [1, 2, 3, 4, 5, 6, 7, 8].find((n) => !slots.includes(n))
      requireRule(
        slot !== undefined,
        'CAPACITY_EXHAUSTED',
        'No quedan cupos. No se realizó ningún cobro.',
        409,
      )
      target.slot = slot
      target.paymentOperationId = input.operationId
      target.chargeId = null
      target.failure = null
      const operation = { intent, teamId, method: selected }
      saveOperation(t, input.operationId, operation)
      const common = { payerId: target.ownerId, realMoneyMoved: false as const }
      if (selected === 'FREE') {
        this.confirm(t, target, { ...common, method: 'FREE', amount: 0, chargeId: null })
      } else if (selected === 'SIMULATED_MONEY') {
        requireRule(
          input.card !== undefined,
          'INVALID_CONFIGURATION',
          'Faltan los datos del pago simulado.',
        )
        const decision = this.simulator.decide(teamId + ':' + input.operationId, input.card)
        const configured = t.entryPolicy.methods.find((m) => m.method === 'SIMULATED_MONEY')
        requireRule(
          configured?.method === 'SIMULATED_MONEY',
          'PAYMENT_METHOD_NOT_CONFIGURED',
          'El método no está configurado.',
        )
        if (decision.approved) {
          requireRule(
            decision.reference !== null,
            'INVALID_CONFIGURATION',
            'Falta la referencia simulada.',
          )
          target.chargeId = 'sim:' + teamId + ':' + input.operationId
          this.confirm(t, target, {
            ...common,
            ...configured,
            chargeId: target.chargeId,
            reference: decision.reference,
            maskedCard: decision.maskedCard,
            simulated: true,
          })
          saveOperation(t, input.operationId, { ...operation, simulated: decision })
        } else {
          target.slot = null
          target.failure = failure(
            'SIMULATED_PAYMENT_DECLINED',
            'La pasarela simulada rechazó la tarjeta.',
            422,
          )
          saveOperation(t, input.operationId, {
            ...operation,
            error: target.failure,
            simulated: decision,
          })
        }
      } else target.status = 'PAYMENT_PENDING'
    })
    const prepared = this.team(await this.repository.read(id), teamId)
    if (
      (prepared.status === 'PAYMENT_PENDING' || prepared.status === 'COMPENSATING') &&
      prepared.paymentOperationId === input.operationId
    )
      await this.resume(id, teamId)
    const completed = await this.repository.read(id)
    const outcome = getOperation(completed, input.operationId)
    if (outcome?.error !== undefined) throwFailure(outcome.error)
    return this.team(completed, teamId)
  }
  async resume(id: string, teamId: string): Promise<void> {
    const t = await this.repository.read(id)
    const team = this.team(t, teamId)
    if (
      !['PAYMENT_PENDING', 'COMPENSATING'].includes(team.status) ||
      team.paymentOperationId === null
    )
      return
    const operationId = team.paymentOperationId
    const op = getOperation(t, operationId)
    requireRule(
      op?.method === 'CREDITS',
      'INVALID_TEAM_STATE',
      'La intención de créditos es inválida.',
      409,
    )
    const method = t.entryPolicy.methods.find((m) => m.method === 'CREDITS')
    requireRule(
      method?.method === 'CREDITS',
      'INVALID_CONFIGURATION',
      'Falta la tarifa de créditos.',
    )
    const root = 'entry:' + teamId + ':' + operationId
    const expected: EntryCharge = {
      operationId: root + ':charge',
      tournamentId: id,
      teamId,
      payerId: team.ownerId,
      amount: method.amount,
    }
    if (team.status === 'PAYMENT_PENDING') {
      let charge: EntryChargeResult
      try {
        charge = await this.wallet.charge(expected)
        requireRule(
          validWalletResult(charge, expected),
          'SERVICE_UNAVAILABLE',
          'Wallet devolvió un cobro incompatible.',
          503,
        )
      } catch (error: unknown) {
        await this.repository.change(id, (current) => {
          const target = this.team(current, teamId)
          if (target.status !== 'PAYMENT_PENDING' || target.paymentOperationId !== operationId)
            return
          const definitive =
            error instanceof RegistrationError &&
            error.code === 'INSUFFICIENT_BALANCE' &&
            error.status === 422
          target.failure = definitive
            ? failure('INSUFFICIENT_BALANCE', 'No hay créditos disponibles suficientes.', 422)
            : failure(
                'PAYMENT_UNCERTAIN',
                'No se pudo comprobar el cobro; se conserva la reserva y se reintentará la misma operación.',
              )
          if (definitive) {
            target.status = 'PENDING_PAYMENT'
            target.slot = null
            saveOperation(current, operationId, { ...op, error: target.failure })
          }
        })
        return
      }
      await this.repository.change(id, (current) => {
        const target = this.team(current, teamId)
        if (target.status !== 'PAYMENT_PENDING' || target.paymentOperationId !== operationId) return
        target.chargeId = charge.chargeId
        if (charge.status === 'REFUNDED') {
          target.status = 'PENDING_PAYMENT'
          target.slot = null
          target.failure = failure(
            'PAYMENT_COMPENSATED',
            'El cobro fue devuelto; el cupo no está confirmado.',
            409,
          )
          saveOperation(current, operationId, { ...op, error: target.failure })
        } else if (registrationOpen(current, this.clock.now())) {
          this.confirm(current, target, {
            method: 'CREDITS',
            amount: method.amount,
            chargeId: charge.chargeId,
            payerId: target.ownerId,
            realMoneyMoved: false,
          })
        } else {
          target.status = 'COMPENSATING'
          target.failure = failure(
            'PAYMENT_COMPENSATING',
            'La inscripción cerró durante el cobro; devolución pendiente.',
          )
        }
      })
    }
    const current = this.team(await this.repository.read(id), teamId)
    if (
      current.status !== 'COMPENSATING' ||
      current.chargeId === null ||
      current.paymentOperationId !== operationId
    )
      return
    const refundExpected = { ...expected, operationId: root + ':refund' }
    try {
      const refunded = await this.wallet.refund(current.chargeId, refundExpected.operationId)
      requireRule(
        validWalletResult(refunded, refundExpected, current.chargeId) &&
          refunded.status === 'REFUNDED',
        'SERVICE_UNAVAILABLE',
        'No se pudo comprobar la devolución.',
        503,
      )
    } catch {
      await this.repository.change(id, (next) => {
        const target = this.team(next, teamId)
        if (target.status === 'COMPENSATING' && target.paymentOperationId === operationId)
          target.failure = failure(
            'PAYMENT_COMPENSATING',
            'No se pudo comprobar la devolución; se conserva la reserva.',
          )
      })
      return
    }
    await this.repository.change(id, (next) => {
      const target = this.team(next, teamId)
      if (target.status !== 'COMPENSATING' || target.paymentOperationId !== operationId) return
      target.status = 'PENDING_PAYMENT'
      target.slot = null
      target.failure = failure(
        'PAYMENT_COMPENSATED',
        'Se devolvieron los créditos porque la inscripción cerró.',
        409,
      )
      saveOperation(next, operationId, { ...op, error: target.failure })
    })
  }
  async reconcile(): Promise<void> {
    for (const t of await this.repository.list())
      for (const team of t.teams) {
        if (team.status !== 'PAYMENT_PENDING' && team.status !== 'COMPENSATING') continue
        try {
          await this.resume(t.id, team.id)
        } catch {
          /* La intención durable permanece para la siguiente pasada. */
        }
      }
  }
  async view(id: string, subject: string) {
    const t = await this.repository.read(id)
    const confirmed = t.teams.filter((x) => x.status === 'CONFIRMED').length
    const reserved = t.teams.filter(
      (x) => x.status === 'PAYMENT_PENDING' || x.status === 'COMPENSATING',
    ).length
    return {
      tournament: publicTournament(t, this.clock.now()),
      capacity: {
        confirmed,
        reserved,
        available: 8 - confirmed - reserved,
        teamSize: t.teamSize ?? 2,
        confirmedPeople: confirmed * (t.teamSize ?? 2),
        totalPeople: 8 * (t.teamSize ?? 2),
      },
      teams: t.teams.filter((x) => memberOf(x, subject)).map((team) => publicTeam(id, team)),
    }
  }
  async list() {
    return (await this.repository.list()).map((t) => publicTournament(t, this.clock.now()))
  }
}
