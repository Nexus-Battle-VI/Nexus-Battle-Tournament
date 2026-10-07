# Tournament v3: modalidades y ampliación HU-85

Base remota verificada el 7 de octubre de 2026: `2679af41c47519578bbb21fbd82ebb4521b3869d`.
Trabajo aislado en `tmp/tournament-modes-hu85-20261007`, rama `feat/tournament-modes-hu85-20261007`.
El checkout original `feat/hu-77-84-inscripcion` se conserva con sus cambios ajenos.
La copia preparada es otro repositorio Git, limpio en `c9446f8e3ccabd8eda14ff7fd3fde107d3361cf8`.

## Registro

`POST /api/v1/tournaments/admin` admite `tournamentMode: SOLO | DUO | TRIO`.
El servidor deriva `teamSize: 1 | 2 | 3`; el cliente no puede imponer ese tamaño.
Omitir modalidad es compatibilidad explícita v2: DUO y administración anterior.
Un valor inválido, incluido null, se rechaza; nunca selecciona otra modalidad.

`POST /api/v1/tournaments/{id}/teams` recibe nombre, avatar de Account,
`operationId` e `invitedMemberIds`, que contiene solamente los invitados en orden.
El owner se agrega desde JWT en posición cero. SOLO envía un arreglo vacío.
El DTO antiguo `companionId` se conserva exclusivamente para DUO. Mezclar ambos
campos es inválido. La respuesta contiene `members` con sujeto, posición y
consentimiento individual; `companionId` es alias v2 en DUO y null en SOLO/TRIO.

Todos los miembros consienten y son elegibles antes de confirmar el cupo.
No hay edición de roster: cancelar/rechazar una intención permite registrar otra.
El consentimiento de inscripción no necesita héroe ni acepta una justa.
El owner paga una vez por equipo con la tarifa y los métodos configurados.
Recibos anteriores e intents de create/register/consent/entry no se recalculan.

La publicación exige ocho equipos completos y 8/16/24 humanos únicos.
V3 usa identificadores opacos de justa; E1–E13 y Final son etiquetas del grafo.
V2 conserva IDs, snapshot y operaciones existentes.

## Límite entre Combat y Tournament

`ProjectCombatRecord` sigue siendo el único escritor de eventos HU-83.
Combat informa sala, héroes, inicio real, eventos y desenlace del motor.
`ArchivedTournamentMatchReadAdapter` recupera ese mismo archivo y valida la
continuidad; `Progressions` confirma solamente su terminal completo y coherente.
Se recuperaron selectivamente progression, Progressions, LifecyclePorts,
repositorios de lifecycle y consumidor de premios de c9446f8. No se portaron
observación/enlaces ni se reemplazaron app.module, schema o database completos.

El avance resuelve fuentes SEED/WINNER/LOSER y actualiza los equipos registrados
de las justas HU-83 existentes. El snapshot publicado permanece inmutable.
E9 cruza perdedor E6 con ganador E7; E10 cruza perdedor E5 con ganador E8.
Final usa ganador E11 y ganador E13; no hay una segunda final.
NO_WINNER mantiene su necesidad de resolución y no se transforma en ausencia.
La proyección de estadísticas cuenta resultados estables, sin incrementos en retries.

## DDL y dependencias

001–004 publicados se conservan byte a byte, incluida 004-tournament-admin-actions.
005 queda reservado para la integración separada de enlaces externos; no se porta
la migración local 004-tournament-external-links ni se registra con otro significado.
006-tournament-mode-members-progression agrega modalidad/tamaño, migra miembros DUO,
reemplaza funciones de validación mediante una migración nueva e integra lifecycle.
Las restricciones diferidas validan roster/consentimientos en el motor. La PK de
registration_members mantiene unicidad humana por torneo; la reserva del último
cupo sigue en la transacción de inscripción y no abarca llamadas de red.

Wallet/Inventory preparados exigen diez campos canónicos y `finalRoomId` string.
Una final por ausencia necesitará ampliar esos consumidores para una resolución
Tournament sin sala. Este repositorio no inventará una sala ni marcará entregas
completas mientras ese contrato esté pendiente. Se informó al Chat A.
La versión local propuesta `torneos-v3.0.0` debe reconciliarse con su contrato común
en Infrastructure antes de integrar PR. Solo Tournament se modifica en este chat.

## Evidencia y límites

El typecheck de la base limpia pasó antes de editar. Las suites usan Account,
JWT y gateways de pago controlados; no acreditan personas reales ni movimientos
financieros reales. PostgreSQL de pruebas es un motor real 18.4 aislado. La suite
también conserva compatibilidad con PostgreSQL 17 de Testcontainers/CI.
Los controles finales y sus SHA se registran en el estado del Chat B; un test
skipped permanece pendiente y no cuenta como integración real de Combat.
