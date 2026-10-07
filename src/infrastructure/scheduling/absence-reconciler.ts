import type { EncounterAbsences } from '../../application/use-cases/EncounterAbsences'

/**
 * Resuelve el avance por ausencia de las justas cuya ventana de aceptación
 * cerró. Independiente de visitas del navegador; idempotente.
 */
export class AbsenceReconciler {
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false

  constructor(
    private readonly absences: EncounterAbsences,
    private readonly enabled = true,
  ) {}

  async sweep(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.absences.sweep()
    } finally {
      this.running = false
    }
  }

  onModuleInit(): void {
    if (!this.enabled) return
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
