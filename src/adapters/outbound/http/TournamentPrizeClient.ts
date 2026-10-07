import type { TournamentPrizeDestination } from '../../../application/ports/LifecyclePorts'
import type { PrizeGrant } from '../../../domain/prize'
import { RegistrationError, requireRule } from '../../../domain/registration'
import { signInternalRequest } from '../identity/internal-signature'
export class TournamentPrizeClient implements TournamentPrizeDestination {
  constructor(
    private readonly walletUrl: string | undefined,
    private readonly inventoryUrl: string | undefined,
    private readonly secret: string | null,
  ) {}
  async grant(command: PrizeGrant): Promise<unknown> {
    requireRule(
      command.heroId !== null,
      'PRIZE_RECIPIENT_REQUIRED',
      'Falta un héroe receptor validado.',
      409,
    )
    const base = command.kind === 'CREDITS' ? this.walletUrl : this.inventoryUrl
    const path =
      command.kind === 'CREDITS'
        ? '/api/internal/v1/wallet/credits/tournament-prize'
        : '/api/internal/v1/inventory/tournament-prizes'
    if (!base || !this.secret)
      throw new RegistrationError(
        'PRIZE_DESTINATION_UNAVAILABLE',
        'La integración de premios no está configurada.',
        503,
      )
    const timestamp = String(Date.now())
    let response: Response
    try {
      response = await fetch(new URL(path, base), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-service': 'tournament',
          'x-internal-timestamp': timestamp,
          'x-internal-signature': signInternalRequest(this.secret, {
            service: 'tournament',
            method: 'POST',
            path,
            timestamp,
            body: command,
          }),
        },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(5000),
      })
    } catch {
      throw new RegistrationError(
        'PRIZE_DESTINATION_UNAVAILABLE',
        'No se pudo confirmar el premio; se conserva el derecho para reintentar.',
        503,
      )
    }
    if (!response.ok)
      throw new RegistrationError(
        response.status === 409 ? 'PRIZE_DESTINATION_CONFLICT' : 'PRIZE_DESTINATION_UNAVAILABLE',
        'El destino no confirmó la entrega; se conserva el mismo identificador.',
        503,
      )
    return response.json().catch(() => null) as Promise<unknown>
  }
}
