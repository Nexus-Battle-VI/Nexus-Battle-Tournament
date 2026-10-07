import type { Registrations } from '../../application/use-cases/Registrations'
export class RegistrationReconciler {
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false
  constructor(private readonly registrations: Registrations) {}
  onModuleInit(): void {
    const sweep = async (): Promise<void> => {
      if (this.running) return
      this.running = true
      try {
        await this.registrations.reconcile()
      } catch {
        /* Database unavailable: retry on next sweep. */
      } finally {
        this.running = false
      }
    }
    this.timer = setInterval(() => {
      void sweep()
    }, 5000)
    this.timer.unref()
    void sweep()
  }
  onModuleDestroy(): void {
    clearInterval(this.timer)
  }
}
