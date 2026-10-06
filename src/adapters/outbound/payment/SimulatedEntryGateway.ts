import type {
  SimulatedCard,
  SimulatedDecision,
  SimulatedEntryPayment,
} from '../../../application/ports/RegistrationPorts'
import { requireRule } from '../../../domain/registration'

/** Política HU-59 de Commerce a8b4e47; la durabilidad pertenece a Tournament. */
export class SimulatedEntryGateway implements SimulatedEntryPayment {
  decide(transactionId: string, card: SimulatedCard): SimulatedDecision {
    requireRule(
      [card.holder, card.number, card.expiry, card.securityCode].every(
        (value) => typeof value === 'string' && value.trim().length > 0,
      ),
      'INVALID_CONFIGURATION',
      'Los cuatro datos del pago simulado son obligatorios.',
    )
    const digits = card.number.replace(/\D/gu, '')
    const maskedCard = digits.length > 4 ? digits.slice(-4) : '****'
    const approved = !digits.endsWith('0000')
    return {
      approved,
      reference: approved ? 'sim-' + transactionId : null,
      maskedCard,
      declineReason: approved ? null : 'La pasarela simulada rechazó la tarjeta.',
    }
  }
}
