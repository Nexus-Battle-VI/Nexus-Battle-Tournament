import {
  createPrizeDelivery,
  deliveryStatus,
  grantCommand,
  validatePrizeConfiguration,
  validatePrizeReceipt,
} from '../../domain/prize'
import { RegistrationError, requireRule } from '../../domain/registration'
import type { ClockPort } from '../ports/ClockPort'
import type { RegistrationRepository } from '../ports/RegistrationPorts'
import type {
  LifecycleRepository,
  TournamentPrizeDestination,
  TournamentPrizeRecipients,
} from '../ports/LifecyclePorts'
export const PRIZES = Symbol('Prizes')
export class Prizes {
  constructor(
    readonly repository: LifecycleRepository,
    private readonly tournaments: RegistrationRepository,
    private readonly destination: TournamentPrizeDestination,
    private readonly clock: ClockPort,
    private readonly recipients?: TournamentPrizeRecipients,
  ) {}
  async view(id: string) {
    await this.tournaments.read(id)
    const s = await this.repository.read(id)
    return {
      configuration: s.configuration,
      champion: s.champion,
      delivery: s.delivery === null ? null : { ...s.delivery, status: deliveryStatus(s.delivery) },
    }
  }
  async approve(id: string, actor: string, raw: unknown) {
    const c = validatePrizeConfiguration(raw, (await this.tournaments.read(id)).teamSize ?? 2)
    requireRule(
      (await this.tournaments.read(id)).bracket != null,
      'BRACKET_REQUIRED',
      'Publica las llaves antes de aprobar el premio.',
      409,
    )
    await this.repository.change(id, (s) => {
      if (s.configuration !== null) {
        requireRule(
          s.configuration.operationId === c.operationId &&
            JSON.stringify(s.configuration.allocations) === JSON.stringify(c.allocations),
          'PRIZE_CONFIGURATION_CONFLICT',
          'El torneo ya tiene otro premio aprobado.',
          409,
        )
        return
      }
      s.configuration = { ...c, approvedBy: actor, approvedAt: this.clock.now().toISOString() }
    })
    return this.view(id)
  }
  async deliver(id: string, actor: string) {
    await this.tournaments.read(id)
    const delivery = await this.repository.change(id, (s) => {
      requireRule(
        s.champion !== null,
        'CHAMPION_REQUIRED',
        'La final debe confirmar al campeón antes del premio.',
        409,
      )
      requireRule(
        s.configuration !== null,
        'PRIZE_NOT_APPROVED',
        'Falta aprobar la configuración del premio.',
        409,
      )
      s.delivery ??= createPrizeDelivery(
        id,
        s.champion,
        s.configuration,
        actor,
        this.clock.now().toISOString(),
      )
      return structuredClone(s.delivery)
    })
    // No SQL lock spans a network call. Destinations deduplicate the immutable operationId.
    for (const line of delivery.lines.filter((l) => l.status === 'PENDING')) {
      const latest = (await this.repository.read(id)).delivery?.lines.find(
        (l) => l.operationId === line.operationId,
      )
      if (
        latest?.status === 'DELIVERED' ||
        latest?.lastError === 'PRIZE_DESTINATION_CONFLICT' ||
        latest?.lastError === 'PRIZE_RECEIPT_CONFLICT'
      )
        continue
      try {
        if (line.heroId === null && this.recipients !== undefined) {
          const hero = await this.recipients.heroFor(line.playerId)
          requireRule(
            hero !== null && hero.trim().length > 0,
            'PRIZE_RECIPIENT_REQUIRED',
            'El receptor no tiene un héroe elegible.',
            409,
          )
          await this.repository.change(id, (s) => {
            const current = s.delivery?.lines.find((l) => l.operationId === line.operationId)
            if (current?.heroId === null) current.heroId = hero
          })
        }
        const current = (await this.repository.read(id)).delivery?.lines.find(
          (l) => l.operationId === line.operationId,
        )
        if (current === undefined) throw new Error('Missing persisted prize right')
        const command = grantCommand(current)
        const receiptId = validatePrizeReceipt(command, await this.destination.grant(command))
        await this.repository.change(id, (s) => {
          const current = s.delivery?.lines.find((l) => l.operationId === line.operationId)
          if (!current) throw new Error('Missing persisted prize intent')
          requireRule(
            current.receiptId === null || current.receiptId === receiptId,
            'PRIZE_RECEIPT_CONFLICT',
            'El recibo cambió para la misma entrega.',
            409,
          )
          current.receiptId = receiptId
          current.status = 'DELIVERED'
          current.deliveredAt ??= this.clock.now().toISOString()
          current.lastError = null
          current.responsible = null
        })
      } catch (error: unknown) {
        await this.repository.change(id, (s) => {
          const current = s.delivery?.lines.find((l) => l.operationId === line.operationId)
          if (current?.status === 'PENDING') {
            current.lastError =
              error instanceof RegistrationError ? error.code : 'PRIZE_DESTINATION_UNAVAILABLE'
            current.responsible = 'PRIZE_OPERATIONS'
          }
        })
      }
    }
    return this.view(id)
  }
  async reconcile(): Promise<void> {
    for (const id of await this.repository.pendingDeliveries()) {
      try {
        await this.deliver(id, 'reconciler')
      } catch {
        /* Durable intent is retried on the next sweep. */
      }
    }
  }
}
