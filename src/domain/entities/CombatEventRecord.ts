/**
 * Evento de Combat ya proyectado sobre una justa, en la tabla de solo-anadir
 * (`tournament_combat_events`). No es un segundo historial de acciones: es la
 * copia local, ordenada por `seq`, de lo que Combat ya decidio. La autoridad
 * del contenido sigue siendo Combat (vease HU-83, Management#465, restriccion
 * "La consulta del detalle reutiliza el registro de eventos del motor del
 * combate y su orden; no crea un segundo historial de acciones contradictorio").
 */
export interface CombatEventRecord {
  readonly tournamentId: string
  readonly encounterId: string
  /** Secuencia que Combat asigna dentro de su sala. Unica por justa. */
  readonly seq: number
  readonly type: string
  readonly payload: unknown
  readonly occurredAt: Date
}

export interface CombatEventPage {
  readonly events: readonly CombatEventRecord[]
  /** Proximo `afterSeq` a usar para continuar leyendo el archivo completo. */
  readonly nextSeq: number
  /** Cierto si existen mas eventos ya proyectados despues de esta pagina. */
  readonly hasMore: boolean
}
