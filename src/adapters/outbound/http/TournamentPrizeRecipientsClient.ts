import type { TournamentPrizeRecipients } from '../../../application/ports/LifecyclePorts'
import { RegistrationError, record, requireRule } from '../../../domain/registration'
import { signInternalRequest } from '../identity/internal-signature'
/** Consulta el héroe propio por caller Tournament; no suplantar Combat ni usar IDs del navegador. */
export class TournamentPrizeRecipientsClient implements TournamentPrizeRecipients {
  constructor(
    private readonly inventoryUrl: string | undefined,
    private readonly secret: string | null,
  ) {}
  async heroFor(subject: string): Promise<string | null> {
    if (!this.inventoryUrl || !this.secret)
      throw new RegistrationError(
        'PRIZE_RECIPIENT_CONTRACT_REQUIRED',
        'La consulta del destinatario no está configurada.',
        503,
      )
    const path = '/api/internal/v1/players/' + encodeURIComponent(subject) + '/equipped-hero'
    const timestamp = String(Date.now())
    let response: Response
    try {
      response = await fetch(new URL(path, this.inventoryUrl), {
        method: 'GET',
        headers: {
          'x-internal-service': 'tournament',
          'x-internal-timestamp': timestamp,
          'x-internal-signature': signInternalRequest(this.secret, {
            service: 'tournament',
            method: 'GET',
            path,
            timestamp,
            body: {},
          }),
        },
        signal: AbortSignal.timeout(5000),
      })
    } catch {
      throw new RegistrationError(
        'PRIZE_RECIPIENT_UNAVAILABLE',
        'No se pudo consultar el destinatario del premio.',
        503,
      )
    }
    if (response.status === 404) return null
    const data: unknown = await response.json().catch(() => null)
    requireRule(
      response.ok &&
        record(data) &&
        data.playerId === subject &&
        typeof data.heroId === 'string' &&
        data.heroId.length > 0 &&
        data.heroId.length <= 160 &&
        data.heroId.trim() === data.heroId &&
        Array.from(data.heroId).every(
          (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
        ),
      'PRIZE_RECIPIENT_UNAVAILABLE',
      'Inventory no confirmó un héroe propio para el destinatario.',
      503,
    )
    return data.heroId
  }
}
