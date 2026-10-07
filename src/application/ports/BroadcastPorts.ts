import type { BroadcastState } from '../../domain/broadcast'
export interface BroadcastRepository {
  read(id: string): Promise<BroadcastState>
  change<T>(id: string, action: (state: BroadcastState) => T): Promise<T>
}
