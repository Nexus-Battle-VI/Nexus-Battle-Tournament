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
consentimiento individual; el campo público `companionId` es alias del segundo
integrante cuando existe. En TRIO, `members` define el roster completo.

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
Si 006 ya fue aplicada, una futura migración de enlaces debe utilizar un ordinal
posterior libre. No se permite insertar 005 en un historial aplicado ni habilitar
migraciones fuera de orden para ocultar la colisión.
006-tournament-mode-members-progression agrega modalidad/tamaño, migra miembros DUO,
reemplaza funciones de validación mediante una migración nueva e integra lifecycle.
Las restricciones diferidas validan roster/consentimientos en el motor. La PK de
registration_members mantiene unicidad humana por torneo; la reserva del último
cupo sigue en la transacción de inscripción y no abarca llamadas de red.

Wallet/Inventory preparados exigen diez campos canónicos y `finalRoomId` string.
Una final por ausencia conserva derechos PENDING y operaciones estables: requiere
ampliar esos consumidores para una resolución Tournament sin sala. El código
`PRIZE_RESOLUTION_CONTRACT_REQUIRED` evita despachar comandos v1 inválidos.
Además Inventory preparado reserva `/api/internal/v1/players/:id/equipped-hero`
a commerce/notifications/combat y no autoriza Tournament. La composición deja
`PRIZE_RECIPIENT_CONTRACT_REQUIRED` con responsable PRIZE_OPERATIONS; el puerto
admite una futura fuente autorizada. Un héroe ausente/inelegible conserva el
derecho pendiente. En una final jugada se conservan los héroes del archivo oficial.
Se informó a A sobre ambas dependencias. Solo Tournament se modifica en este chat.

## Calendario, aceptación y decisiones HU-85

Los torneos nuevos con modalidad explícita guardan ROUND_ACCEPTANCE_V1 y seis
ventanas UTC de 120 segundos, separadas por diez minutos. El DTO y snapshot
exponen `roundSchedule`; el almacenamiento usa `round_windows`. La configuración
y el snapshot no se editan. Los torneos anteriores sin política mantienen C13.

`POST /api/v1/tournaments/:id/matches/:encounterId/acceptance` acepta exclusivamente
operationId. El JWT identifica al jugador y la pertenencia se comprueba antes de
revelar un recibo. El servidor exige apertura <= ahora < cierre. Cada sujeto tiene
un recibo único con fecha/deadline; aliases de operación y replays son durables.
Inscribirse/consentir, aceptar la justa y ser elegible para Combat son controles distintos.

007-tournament-round-acceptance-resolution agrega calendario, aceptaciones,
operaciones y resoluciones. Una transacción por justa serializa aceptación/cierre;
las PK y guards impiden modificar recibos, decisiones, roster o sorteos. Las llamadas
HTTP ocurren después de guardar intención y lease, fuera de SQL. Dos workers reclaman
la misma intención por justa; E1/E2 pueden continuar en paralelo. Los identificadores
internos son `tournament:${encounterId}:prepare` y `:start`, en worker y recuperación admin.
El actor técnico `tournament-worker` queda en la auditoría con actorType WORKER.

El reconciliador observa cada segundo. Como medida conservadora de disponibilidad,
un cierre incompleto sin observación durable durante los últimos diez segundos produce
WINDOW_INTERRUPTED: mantiene aceptaciones, pero no infiere ganador ni reabre la
ventana. Un reinicio dentro de una ventana OPEN no impide aceptar antes del deadline;
ambos equipos completos conservan su derecho a combatir al cierre, incluso tras una
pausa del worker. GET muestra CLOSED al deadline aunque aún falte la decisión durable.
Una ventana íntegra sin activar produce WINDOW_MISSED. Si los resultados
previos no estaban confirmados a la apertura, PREVIOUS_RESULT_PENDING. La recuperación
de estas incidencias necesita revisión operativa/política; no se reprograma implícitamente.
Las pruebas de reloj representan ticks de un worker sano y separan los casos de caída.

Al cierre ambos completos crean intención de Combat; un solo completo gana por ausencia;
dos incompletos usan el conteo mayor o un bit de `node:crypto.randomInt(2)` si empatan.
El bit y resolución se guardan una sola vez. La identidad del sorteo es resolutionId.
Un error/422/timeout de Combat mantiene la intención pendiente, sala y operaciones;
no adjudica derrota. `scheduledStartAt` y `startedAt` real siguen separados.

La única lectura `/matches` conserva HU-83 y añade la extensión del contrato común:
acceptanceStatus, operationalStatus, acceptedCounts, myAcceptance, blockReason,
resolution, sources y destinations. No expone recibos individuales de otros actores.
ABSENCE no contiene sala, BattleResult, héroes ni eventos; `result` continúa null.
PLAYED deriva del archivo validado; NO_WINNER mantiene RESOLUTION_REQUIRED.
La final por ausencia declara campeón desde seeds y genera derechos una sola vez.

## Wire reconciliado

Se implementa revisión documental 2 de torneos-v3.0.0 (Infrastructure 043db7c).
El adaptador traduce tournamentMode a mode y envía teamSize, con HMAC caller tournament.
El cuerpo DUO histórico permanece intacto. El lector usa la configuración v3 de Combat
para exigir 1/2/3 participantes por lado; también valida los miembros contra HU-83.
Combat ejercitado desde el checkout de C, 317726d (base dd67d47); su versión numérica
interna es distinta de la versión pública de Tournament.

## Evidencia y límites

El typecheck de la base limpia pasó antes de editar. Las suites usan Account,
JWT y gateways de pago controlados; no acreditan personas reales ni movimientos
financieros reales. PostgreSQL de pruebas es un motor real 18.4 aislado. La suite
también conserva compatibilidad con PostgreSQL 17 de Testcontainers/CI.
Los controles finales y SHA se registran en `estado/chat-B.json` del plan compartido.
La suite `real-combat-modes.spec.ts` ejercita HTTP Nest, PostgreSQL real, HMAC y motor
Combat real para las tres modalidades; TRIO tiene seis participantes y E1/E2 concurrentes.
Account/Inventory y el verificador JWT son dobles explícitos; Combat usa memoria en
este recorrido. La persistencia Mongo de Combat corresponde a la evidencia de C.
No se afirman cuentas reales, entregas reales de premio, aceptación del PO ni despliegue.
