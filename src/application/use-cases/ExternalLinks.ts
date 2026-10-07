import { normalizeExternalUrl } from '../../domain/external-links'
import { requireRule } from '../../domain/registration'
import type { ClockPort } from '../ports/ClockPort'
import type { ExternalLinksRepository } from '../ports/ExternalLinksPorts'
import type { RegistrationRepository } from '../ports/RegistrationPorts'
export const EXTERNAL_LINKS = Symbol('ExternalLinks')
export interface SaveExternalLinks {
  liveUrl: string | null
  youtubeArchiveUrl: string | null
  expectedRevision: number
}
export class ExternalLinks {
  constructor(
    readonly repository: ExternalLinksRepository,
    private readonly tournaments: RegistrationRepository,
    private readonly clock: ClockPort,
  ) {}
  async view(id: string) {
    await this.tournaments.read(id)
    return this.repository.read(id)
  }
  async save(id: string, command: SaveExternalLinks) {
    await this.tournaments.read(id)
    requireRule(
      Number.isSafeInteger(command.expectedRevision) &&
        command.expectedRevision >= 0 &&
        command.expectedRevision < Number.MAX_SAFE_INTEGER,
      'LINKS_INVALID',
      'La revisión debe ser un entero no negativo.',
      422,
    )
    const liveUrl = normalizeExternalUrl(command.liveUrl, false)
    const youtubeArchiveUrl = normalizeExternalUrl(command.youtubeArchiveUrl, true)
    return this.repository.change(id, (state) => {
      if (state.liveUrl === liveUrl && state.youtubeArchiveUrl === youtubeArchiveUrl)
        return structuredClone(state)
      requireRule(
        state.revision === command.expectedRevision,
        'LINKS_CHANGED',
        'Otro administrador corrigió los enlaces. Revisa los valores actuales antes de guardar.',
        409,
      )
      state.liveUrl = liveUrl
      state.youtubeArchiveUrl = youtubeArchiveUrl
      state.revision++
      state.updatedAt = this.clock.now().toISOString()
      return structuredClone(state)
    })
  }
}
