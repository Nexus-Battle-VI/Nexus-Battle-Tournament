import type { TournamentPrizeRecipients } from '../../../application/ports/LifecyclePorts'
import { RegistrationError } from '../../../domain/registration'

/** Inventory reserva la consulta equipada a otros callers. Se necesita contrato autorizado de Tournament. */
export class UnavailableTournamentPrizeRecipients implements TournamentPrizeRecipients {
  heroFor(): Promise<string | null> {
    return Promise.reject(
      new RegistrationError(
        'PRIZE_RECIPIENT_CONTRACT_REQUIRED',
        'Falta una fuente autoritativa de héroe receptor autorizada para Tournament. El derecho sigue pendiente.',
        503,
      ),
    )
  }
}
