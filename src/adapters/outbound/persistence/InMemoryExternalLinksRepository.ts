import type { ExternalLinksRepository } from '../../../application/ports/ExternalLinksPorts'
import { emptyExternalLinks, type ExternalLinksState } from '../../../domain/external-links'
export class InMemoryExternalLinksRepository implements ExternalLinksRepository {
  private readonly states = new Map<string, ExternalLinksState>()
  read(id: string): Promise<ExternalLinksState> {
    return Promise.resolve(structuredClone(this.states.get(id) ?? emptyExternalLinks(id)))
  }
  change<T>(id: string, action: (state: ExternalLinksState) => T): Promise<T> {
    return Promise.resolve().then(() => {
      const state = structuredClone(this.states.get(id) ?? emptyExternalLinks(id))
      const result = action(state)
      this.states.set(id, state)
      return result
    })
  }
}
