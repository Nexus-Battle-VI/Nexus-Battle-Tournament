import type { MatchAcceptanceStore } from '../../../application/ports/MatchAcceptancePorts'
import type { MatchAcceptanceState } from '../../../domain/match-acceptance'
import { requireRule } from '../../../domain/registration'
/** Doble explícito de la misma decisión serializada por justa. */
export class InMemoryMatchAcceptanceStore implements MatchAcceptanceStore {
  private readonly rows = new Map<string, MatchAcceptanceState>()
  private readonly operations = new Map<string, string>()
  private readonly tails = new Map<string, Promise<void>>()
  read(id: string, encounterId: string): Promise<MatchAcceptanceState | null> {
    return Promise.resolve(
      structuredClone(this.rows.get(JSON.stringify([id, encounterId])) ?? null),
    )
  }
  async change<T>(
    initial: MatchAcceptanceState,
    action: (state: MatchAcceptanceState) => T,
  ): Promise<T> {
    const key = JSON.stringify([initial.tournamentId, initial.encounterId]),
      prior = this.tails.get(key) ?? Promise.resolve()
    let release: () => void = () => undefined
    const tail = new Promise<void>((resolve) => {
      release = resolve
    })
    this.tails.set(key, tail)
    await prior
    try {
      const state = structuredClone(this.rows.get(key) ?? initial),
        result = action(state)
      for (const [op, value] of Object.entries(state.operations)) {
        const opKey = JSON.stringify([state.tournamentId, op]),
          intent = JSON.stringify([state.encounterId, value.subject, value.receiptId])
        requireRule(
          !this.operations.has(opKey) || this.operations.get(opKey) === intent,
          'OPERATION_CONFLICT',
          'La operación pertenece a otra aceptación.',
          409,
        )
      }
      for (const [op, value] of Object.entries(state.operations))
        this.operations.set(
          JSON.stringify([state.tournamentId, op]),
          JSON.stringify([state.encounterId, value.subject, value.receiptId]),
        )
      this.rows.set(key, state)
      return structuredClone(result)
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
  resolutions(id: string) {
    return Promise.resolve(
      structuredClone(
        [...this.rows.values()]
          .filter((s) => s.tournamentId === id)
          .flatMap((s) => (s.resolution === null ? [] : [s.resolution])),
      ),
    )
  }
}
