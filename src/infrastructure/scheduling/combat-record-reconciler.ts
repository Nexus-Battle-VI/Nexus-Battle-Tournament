import type { TournamentEncounterRepositoryPort } from '../../application/ports/TournamentEncounterRepositoryPort'
import type { CombatRecordPort } from '../../application/ports/CombatRecordPort'
import { ProjectCombatRecord } from '../../application/use-cases/ProjectCombatRecord'
/** Sincronización del archivo, independiente de visitas del navegador o emisión. */
export class CombatRecordReconciler {
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false
  private readonly projector: ProjectCombatRecord
  constructor(
    private readonly repository: TournamentEncounterRepositoryPort,
    combat: CombatRecordPort,
  ) {
    this.projector = new ProjectCombatRecord(repository, combat)
  }
  async sweep(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const linked = (await this.repository.findLinked?.()) ?? []
      await Promise.allSettled(
        linked.map((encounter) =>
          this.projector.execute(encounter.tournamentId, encounter.encounterId),
        ),
      )
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
