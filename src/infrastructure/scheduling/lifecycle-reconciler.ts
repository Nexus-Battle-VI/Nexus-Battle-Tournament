import type { Progressions } from '../../application/use-cases/Progressions'
import type { Prizes } from '../../application/use-cases/Prizes'
/** Avance desde el archivo oficial y recuperación de derechos durables, sin navegador. */
export class LifecycleReconciler {
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false
  constructor(
    private readonly progress: Progressions,
    private readonly prizes: Prizes,
  ) {}
  async sweep(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.progress.reconcile()
      await this.prizes.reconcile()
    } finally {
      this.running = false
    }
  }
  onModuleInit(): void {
    const run = () => {
      void this.sweep().catch(() => undefined)
    }
    this.timer = setInterval(run, 5000)
    this.timer.unref()
    run()
  }
  onModuleDestroy(): void {
    clearInterval(this.timer)
  }
}
