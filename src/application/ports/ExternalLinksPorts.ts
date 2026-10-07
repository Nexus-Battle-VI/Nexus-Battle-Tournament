import type { ExternalLinksState } from '../../domain/external-links'
export interface ExternalLinksRepository {
  read(id: string): Promise<ExternalLinksState>
  change<T>(id: string, action: (state: ExternalLinksState) => T): Promise<T>
}
