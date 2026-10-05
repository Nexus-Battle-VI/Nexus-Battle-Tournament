import { signInternalRequest } from '../identity/internal-signature'
import type {
  TournamentAccounts,
  TournamentWallet,
  EntryCharge,
  EntryChargeResult,
} from '../../../application/ports/RegistrationPorts'
import { RegistrationError, record, requireRule } from '../../../domain/registration'
export class RegistrationServices implements TournamentAccounts, TournamentWallet {
  constructor(
    private readonly accountUrl: string | undefined,
    private readonly walletUrl: string | undefined,
    private readonly secret: string | null,
  ) {}
  private async request(base: string | undefined, path: string, body?: unknown): Promise<unknown> {
    if (!base || !this.secret)
      throw new RegistrationError('SERVICE_UNAVAILABLE', 'La integración no está configurada.', 503)
    const method = body === undefined ? 'GET' : 'POST'
    const timestamp = String(Date.now())
    let response: Response
    try {
      response = await fetch(new URL(path, base), {
        method,
        headers: {
          'content-type': 'application/json',
          'x-internal-service': 'tournament',
          'x-internal-timestamp': timestamp,
          'x-internal-signature': signInternalRequest(this.secret, {
            service: 'tournament',
            method,
            path,
            timestamp,
            body: body ?? {},
          }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      })
    } catch {
      throw new RegistrationError(
        'SERVICE_UNAVAILABLE',
        'No se pudo comprobar la respuesta del servicio.',
        503,
      )
    }
    const data: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const code = record(data) && typeof data.code === 'string' ? data.code : ''
      const known: Record<string, string> = {
        INSUFFICIENT_BALANCE: 'No hay créditos disponibles suficientes.',
        OPERATION_CONFLICT: 'La intención no coincide con la operación guardada.',
        INVALID_TEAM_NAME: 'El nombre incumple la política de Account.',
        INVALID_TEAM_AVATAR: 'El avatar del integrante no está disponible.',
        CHARGE_NOT_FOUND: 'No se encontró el cobro.',
      }
      if (Object.hasOwn(known, code))
        throw new RegistrationError(
          code,
          known[code] ?? 'La operación fue rechazada.',
          response.status,
        )
      if (response.status === 404)
        throw new RegistrationError('DEPENDENCY_NOT_FOUND', 'La referencia no existe.', 404)
      throw new RegistrationError(
        'SERVICE_UNAVAILABLE',
        'No se pudo comprobar la operación del servicio.',
        503,
      )
    }
    return data
  }
  async eligible(subject: string): Promise<boolean> {
    try {
      const data = await this.request(
        this.accountUrl,
        '/api/internal/accounts/' + encodeURIComponent(subject) + '/tournament-eligibility',
      )
      requireRule(
        record(data) && data.subject === subject && typeof data.eligible === 'boolean',
        'SERVICE_UNAVAILABLE',
        'Account devolvió una respuesta incompatible.',
        503,
      )
      return data.eligible
    } catch (error: unknown) {
      if (error instanceof RegistrationError && error.status === 404) return false
      throw error
    }
  }
  async validateIdentity(name: string, avatarSubject: string) {
    const data = await this.request(
      this.accountUrl,
      '/api/internal/accounts/tournament-team-identity/validation',
      { name, avatarSubject },
    )
    requireRule(
      record(data) &&
        typeof data.name === 'string' &&
        record(data.avatar) &&
        data.avatar.kind === 'ACCOUNT_AVATAR' &&
        data.avatar.subject === avatarSubject &&
        data.policyVersion === 'account-team-identity-v1',
      'SERVICE_UNAVAILABLE',
      'Account devolvió una identidad incompatible.',
      503,
    )
    return {
      name: data.name,
      avatar: { kind: 'ACCOUNT_AVATAR' as const, subject: avatarSubject },
      policyVersion: 'account-team-identity-v1' as const,
    }
  }
  async charge(command: EntryCharge): Promise<EntryChargeResult> {
    return (await this.request(
      this.walletUrl,
      '/api/internal/v1/wallet/tournament-entry-fees',
      command,
    )) as EntryChargeResult
  }
  async refund(chargeId: string, operationId: string): Promise<EntryChargeResult> {
    return (await this.request(
      this.walletUrl,
      '/api/internal/v1/wallet/tournament-entry-fees/' + encodeURIComponent(chargeId) + '/refunds',
      { operationId },
    )) as EntryChargeResult
  }
}
