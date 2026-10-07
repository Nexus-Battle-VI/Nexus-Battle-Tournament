import {
  emptyLifecycle,
  type LifecycleRepository,
  type TournamentLifecycle,
} from '../../../application/ports/LifecyclePorts'
export class InMemoryLifecycleRepository implements LifecycleRepository {
  private readonly rows = new Map<string, TournamentLifecycle>()
  read(id: string): Promise<TournamentLifecycle> {
    return Promise.resolve(structuredClone(this.rows.get(id) ?? emptyLifecycle(id)))
  }
  change<T>(id: string, action: (state: TournamentLifecycle) => T): Promise<T> {
    try {
      const state = structuredClone(this.rows.get(id) ?? emptyLifecycle(id))
      const result = action(state)
      this.rows.set(id, state)
      return Promise.resolve(result)
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }
  pendingDeliveries(): Promise<string[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((s) =>
          s.delivery?.lines.some(
            (l) =>
              l.status === 'PENDING' &&
              !['PRIZE_DESTINATION_CONFLICT', 'PRIZE_RECEIPT_CONFLICT'].includes(l.lastError ?? ''),
          ),
        )
        .map((s) => s.tournamentId),
    )
  }
}
