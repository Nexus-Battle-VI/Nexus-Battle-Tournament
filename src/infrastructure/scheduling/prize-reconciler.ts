import type { Prizes } from '../../application/use-cases/Prizes'
export class PrizeReconciler {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  constructor(private readonly prizes: Prizes) {}
  onModuleInit(): void {
    const ms = Number(process.env.PRIZE_RECONCILE_INTERVAL_MS ?? 5000)
    if (!Number.isSafeInteger(ms) || ms < 1000) return
    this.timer = setInterval(() => {
      void this.tick()
    }, ms)
    this.timer.unref()
    void this.tick()
  }
  async tick(): Promise<void> {
    if (this.running !== null) return this.running
    this.running = this.prizes
      .reconcile()
      .catch(() => undefined)
      .finally(() => {
        this.running = null
      })
    return this.running
  }
  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    await this.running
  }
}
