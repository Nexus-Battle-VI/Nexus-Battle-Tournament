import type { AcceptanceReconciliation } from '../../application/use-cases/AcceptanceReconciliation'
export class AcceptanceReconciler {
  private timer: ReturnType<typeof setInterval> | undefined
  private running: Promise<void> | null = null
  constructor(private readonly reconciliation: AcceptanceReconciliation) {}
  async sweep(): Promise<void> {
    if (this.running !== null) return this.running
    this.running = this.reconciliation
      .sweep()
      .catch(() => undefined)
      .finally(() => {
        this.running = null
      })
    return this.running
  }
  onModuleInit(): void {
    const run = () => {
      void this.sweep()
    }
    this.timer = setInterval(run, 1000)
    this.timer.unref()
    run()
  }
  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer)
    await this.running
  }
}
