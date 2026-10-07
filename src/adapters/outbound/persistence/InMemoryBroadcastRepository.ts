import type { BroadcastRepository } from '../../../application/ports/BroadcastPorts'
import { emptyBroadcast, type BroadcastState } from '../../../domain/broadcast'
export class InMemoryBroadcastRepository implements BroadcastRepository {
  private readonly states = new Map<string, BroadcastState>()
  read(id: string): Promise<BroadcastState> {
    return Promise.resolve(structuredClone(this.states.get(id) ?? emptyBroadcast(id)))
  }
  change<T>(id: string, action: (state: BroadcastState) => T): Promise<T> {
    try {
      const state = structuredClone(this.states.get(id) ?? emptyBroadcast(id))
      const result = action(state)
      this.states.set(id, state)
      return Promise.resolve(result)
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }
}
