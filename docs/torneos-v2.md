# Incremento local HU-77/84/78 compatible con HU-83

Contrato consumido: `torneos-hu77-84-78-hu83-v2.0.0`. Base publicada: `21951787de52c47ba29891ada412ff187162f0b5` (Tournament PR #5). Este documento describe la implementación local para Web y QA; las historias y la tabla de llaves aún requieren aceptación funcional. No se implementa ejecución de combates ni avance HU-80.

## API pública

Prefijo `/api/v1/tournaments`. Todas las rutas requieren token de acceso verificado con `AUTH_MODE=jwt`. El actor sale del JWT. `ADMINISTRATOR` incluye `SUPER_ADMINISTRATOR`; el cuerpo nunca establece propietario, pagador, miembros adicionales, importe ni cupo. Los cuerpos rechazan propiedades desconocidas, también dentro de avatar y tarjeta.

| Método/ruta relativa                   | Autorización                    | Cuerpo                                  | Respuesta 200                                                          |
| -------------------------------------- | ------------------------------- | --------------------------------------- | ---------------------------------------------------------------------- |
| `GET /`                                | Identidad autenticada           | —                                       | Array de torneos                                                       |
| `POST /admin`                          | Administrador                   | Configuración descrita abajo            | Torneo                                                                 |
| `GET /:id/registration`                | Identidad autenticada           | —                                       | `{tournament, capacity, teams}`; solo equipos donde participa el actor |
| `POST /:id/teams`                      | Jugador creador                 | `{operationId,name,avatar,companionId}` | Equipo y recibo de registro                                            |
| `POST /:id/teams/:teamId/consent`      | Jugador compañero               | `{operationId,accept:boolean}`          | Equipo actualizado                                                     |
| `POST /:id/teams/:teamId/cancel`       | Cualquiera de los dos jugadores | `{operationId}`                         | Equipo cancelado; solo antes de pagar                                  |
| `POST /:id/teams/:teamId/entry`        | Jugador creador                 | `{operationId,method?,card?}`           | Equipo; comprobar `status` y `entryReceipt`                            |
| `GET /:id/bracket`                     | Identidad autenticada           | —                                       | `{bracket:null}` o `{bracket:snapshot}`                                |
| `POST /admin/:id/bracket`              | Administrador                   | `{operationId}`                         | Snapshot publicado                                                     |
| `GET /:id/matches`                     | Identidad autenticada           | —                                       | Array HU-83, sin envoltorio `matches`                                  |
| `GET /:id/matches/:matchId?afterSeq=0` | Identidad autenticada           | —                                       | Detalle HU-83 y página de eventos                                      |

`operationId` es una cadena de 1–100 caracteres, no vacía tras recortar espacios. Se comparte entre acciones del mismo torneo: reutilizarlo para otra intención o actor produce `OPERATION_CONFLICT`. La creación administrativa usa un espacio de operaciones propio y genera el `id` del torneo en el servidor. Los replays válidos devuelven el estado actual y conservan los recibos originales, incluso después del cierre. Una decisión de pago rechazada sigue rechazada al repetir su operación.

### Configurar el torneo

`POST /admin` recibe `operationId`, `name` (1–100 caracteres), `opensAt`, `closesAt`, `startsAt` y exactamente una de `entryPolicy` o `entryFee` de compatibilidad. Las fechas ISO requieren zona y se guardan en UTC. `opensAt < closesAt <= startsAt`. La separación entre cualquier par de inicios es al menos `91 × 24 horas`, en ambos sentidos; exactamente 91 días se permite.

Ejemplo de política mixta; sus importes son ilustrativos, no precios del producto:

```json
{
  "operationId": "crear-torneo-1",
  "name": "Torneo de prueba",
  "opensAt": "2026-10-01T00:00:00Z",
  "closesAt": "2026-10-10T00:00:00Z",
  "startsAt": "2026-10-12T00:00:00Z",
  "entryPolicy": {
    "version": 1,
    "free": false,
    "methods": [
      { "method": "CREDITS", "amount": 100 },
      { "method": "SIMULATED_MONEY", "amountMinor": 250050, "currency": "COP", "minorUnit": 2 }
    ]
  }
}
```

Política gratuita: `{version:1,free:true,methods:[]}`. La política de pago admite uno o dos métodos diferentes. Los importes son enteros positivos seguros; moneda de tres letras mayúsculas y `minorUnit` entero entre 0 y 6. No existe ruta de edición de política. `entryFee:0` equivale a gratuito; un entero positivo configura créditos. La respuesta conserva `entryFee`: 0 si gratuito, importe en créditos si existe ese método, `null` si solo admite dinero simulado. Web debe usar `entryPolicy` como autoridad.

### Registro y consentimiento

El avatar es `{kind:"ACCOUNT_AVATAR",subject:"<subject de un integrante>"}`; Account debe comprobar su existencia. Account también aplica su política vigente de nombre/blacklist. Tournament espera el nombre normalizado con trim y espacios colapsados, sin inventar unicidad frente a nombres de cuenta.

Registrar crea `AWAITING_CONSENT`, guarda consentimiento del creador y emite `registrationReceipt` de tipo `TEAM_REGISTRATION`, estado `REGISTERED`. Este recibo acredita registro, sin cupo pagado. El compañero debe aceptar desde su JWT para llegar a `PENDING_PAYMENT`. Rechazar o cancelar produce `CANCELLED` y libera la pertenencia activa. Un integrante no puede estar en dos equipos activos del mismo torneo.

### Confirmar el cupo

El cliente no envía importe, pagador ni cupo. El servidor obtiene el precio de la política persistida y reserva uno de los ocho cupos bajo bloqueo del torneo antes de llamar a Wallet.

- Gratuito: enviar `{operationId}` sin método ni tarjeta.
- Solo créditos: `method:"CREDITS"` es opcional por compatibilidad.
- Solo dinero simulado o política mixta: seleccionar explícitamente un método configurado.
- Primer intento simulado: `card:{holder,number,expiry,securityCode}`, cuatro cadenas no vacías. Los replays no necesitan tarjeta ni repetir el método; la intención persistida fija el método.

La simulación reutiliza la política/formato de Commerce HU-59: dígitos terminados en `0000` rechazan; los demás aprueban, con referencia `sim-<teamId>:<operationId>` y máscara de los últimos cuatro dígitos, o `****` si no hay suficientes. No realiza llamadas a Commerce ni al checkout del carrito, ni añade validación bancaria/Luhn. Decide dentro de la transacción local que guarda intención, cupo y recibo. No se almacenan ni registran PAN, titular, vencimiento, código de seguridad ni hashes de esos datos. Una tarjeta diferente tras rechazo requiere un nuevo `operationId`.

Un cobro en créditos incierto conserva `PAYMENT_PENDING`; una devolución incierta conserva `COMPENSATING`. Ambos reservan cupo y se reconcilian cada cinco segundos y al repetir el intento. `CONFIRMED` exige `entryReceipt` de tipo `ENTRY_CONFIRMATION` con cupo, fecha, método, importe y pagador. Todos los métodos indican `realMoneyMoved:false`; créditos son saldo del juego. El simulado añade `simulated:true`, referencia y máscara. Web debe mostrar pendiente mientras falte `entryReceipt`, aunque la petición responda 200.

Wallet `422 INSUFFICIENT_BALANCE` libera cupo y fija rechazo inmutable de esa operación. `409`, timeout, `503`, cuerpo inválido o eco incompatible conservan la reserva. Si se recupera un cobro después del cierre, se devuelve antes de liberar cupo. Los identificadores salientes son `entry:<teamId>:<operationId>:charge` y `...:refund`; se comprueba el eco completo antes de confirmar o compensar. No hay llamadas de red dentro de transacciones SQL.

Estados de Web:

| Estado             | Acción/interpretación                                          | Ocupa cupo |
| ------------------ | -------------------------------------------------------------- | ---------- |
| `AWAITING_CONSENT` | Compañero acepta/rechaza; ambos pueden cancelar                | No         |
| `PENDING_PAYMENT`  | Creador confirma con operación nueva; ambos pueden cancelar    | No         |
| `PAYMENT_PENDING`  | Cobro incierto; repetir la misma operación/consultar estado    | Sí         |
| `COMPENSATING`     | Devolución por cierre en curso; consultar/repetir la operación | Sí         |
| `CONFIRMED`        | Recibo de cupo disponible                                      | Sí         |
| `CANCELLED`        | Puede registrarse otro equipo con operación nueva              | No         |

`capacity` contiene `{confirmed,reserved,available}`; `reserved` cuenta pagos y compensaciones pendientes. Los errores de negocio responden `{code,message}`. Validación del cuerpo/URL devuelve 400 de Nest; autenticación 401; actor/rol ajeno 403; torneo/equipo inexistente 404. Conflictos 409 incluyen `OPERATION_CONFLICT`, `REGISTRATION_CLOSED`, `ALREADY_REGISTERED`, `CAPACITY_EXHAUSTED`, `CONSENT_REQUIRED`, `INVALID_TEAM_STATE`, `CALENDAR_CONFLICT`, `INSUFFICIENT_CONFIRMED_TEAMS`, `INVALID_BRACKET_ROSTER`, `ENCOUNTER_IDENTITY_CONFLICT`, `IMMUTABLE_BRACKET`, `PAYMENT_COMPENSATED`. Configuración, jugadores/identidad inválidos, método no configurado, saldo insuficiente y pago simulado rechazado usan 422. Account/Wallet no disponibles usan 503; la incertidumbre de créditos se muestra mediante estado/failure persistidos, sin liberar reserva.

## Publicación y lectura HU-83

Se exigen exactamente ocho equipos humanos `CONFIRMED`, cupos 1–8, dieciséis miembros distintos, ambos consentimientos y recibos de confirmación. Con siete se rechaza. En una única transacción se fija `version:2`, `contractVersion`, semillas/cupos, nombre/avatar/miembros y tabla de catorce nodos; se materializan las catorce filas sobre las tablas publicadas de HU-83. El snapshot cierra la inscripción e impide modificaciones posteriores. Publicar nuevamente devuelve el mismo snapshot; una colisión con justa histórica revierte la publicación completa.

| Nodo  | Árbol/ronda | Orígenes, en orden          |
| ----- | ----------- | --------------------------- |
| E1–E4 | MAIN/1      | Semillas 1–2, 3–4, 5–6, 7–8 |
| E5    | MAIN/2      | Ganador E1, ganador E2      |
| E6    | MAIN/2      | Ganador E3, ganador E4      |
| E7    | SECONDARY/2 | Perdedor E1, perdedor E2    |
| E8    | SECONDARY/2 | Perdedor E3, perdedor E4    |
| E9    | SECONDARY/3 | Perdedor E6, ganador E7     |
| E10   | SECONDARY/3 | Perdedor E5, ganador E8     |
| E11   | MAIN/3      | Ganador E5, ganador E6      |
| E12   | SECONDARY/4 | Ganador E9, ganador E10     |
| E13   | SECONDARY/5 | Perdedor E11, ganador E12   |
| Final | FINAL/6     | Ganador E11, ganador E13    |

Una sola final, sin reset. Esta tabla es el snapshot v2 pendiente de revisión funcional; no habilita propagación de resultados. Los IDs nuevos son `<tournamentId>:<etiqueta>` y Web debe codificar `matchId` con `encodeURIComponent` al formar la URL. Los IDs históricos se conservan.

`TournamentMatchesController` es el único controlador de lectura de justas. El listado sigue siendo array; el detalle conserva `teams`, `events`, `nextSeq`, `hasMore` y `logComplete`. `afterSeq` debe ser entero no negativo; hasta 100 eventos por página. Los estados públicos siguen siendo `WAITING_PARTICIPANTS`, `READY`, `IN_PROGRESS`, `FINISHED`.

Las justas nuevas añaden `encounterId`, `bracketTrack`, `registeredTeams` (dos posiciones, objeto o null), `preparationStatus`, `combatRoomId`, `lastSyncedSeq`, `engineLastSeq` y `syncedAt`. E1–E4 están `TEAMS_RESOLVED` en preparación, pero siguen `WAITING_PARTICIPANTS` con `teams:[]`, sin héroes, sala, eventos o resultado fabricados. Las rondas futuras están `WAITING_TEAMS`. `READY`/`PREPARED` exige roster autoritativo de Combat; `IN_PROGRESS`/`IN_BATTLE` y `FINISHED` requieren datos del motor. Los campos aditivos no se añaden retroactivamente a filas históricas sin metadata.

El adaptador HTTP traduce `events:{afterSeq,lastSeq,items}` y los equipos HUMAN de Combat. `teams[].teamId` de Combat es etiqueta del motor; Tournament identifica su equipo por los miembros exactos, independientemente del orden. Rechaza miembros/héroes ajenos, cambio de etiquetas, secuencias incompatibles y eventos reescritos. Una proyección tardía no revierte un cierre, ganador ni cursor archivados. El reconciliador continúa la bitácora de una justa terminada si `logComplete` es falso; si Combat falla, HU-83 conserva la lectura del archivo comprobado. Estas pruebas usan datos sintéticos explícitos; no acreditan combate real.

## Integración interna y configuración

Con `PERSISTENCE_DRIVER=postgres` se requiere `DATABASE_URL`; `memory` es un doble de desarrollo y está prohibido en producción. Usar `AUTH_MODE=jwt`, pool/cliente Cognito y `INTERNAL_SERVICE_AUTH_SECRET`, más `ACCOUNT_BASE_URL`, `WALLET_BASE_URL` y `COMBAT_BASE_URL` como orígenes internos sin `/api`. Sin configuración las integraciones fallan; no se seleccionan fixtures de aplicación. No hay consumidores autorizados de rutas internas de Tournament (`INTERNAL_CALLERS=[]`).

Salidas firmadas como servicio `tournament`, HMAC-SHA256 y timestamp en milisegundos; timeout de cinco segundos:

- Account: `GET /api/internal/accounts/:subject/tournament-eligibility` y `POST /api/internal/accounts/tournament-team-identity/validation` con `{name,avatarSubject}`. Se comprueban ecos y `account-team-identity-v1`.
- Wallet: `POST /api/internal/v1/wallet/tournament-entry-fees` con la intención fijada y `POST /api/internal/v1/wallet/tournament-entry-fees/:chargeId/refunds` con `{operationId}`. Se comprueban `operationId`, pagador, torneo, equipo, importe, chargeId, estado y booleano `applied`.
- Combat, lectura: `GET /api/internal/v1/combat/tournament-rooms/:roomId/record?afterSeq=N`. La firma usa el path sin query según el guard publicado de Combat.
- Combat, escritura (HU-85): `POST /api/internal/v1/combat/tournament-rooms` (crea la sala de una justa) y `POST /api/internal/v1/combat/tournament-rooms/:roomId/start`. El `operationId` hacia Combat es determinista (`tournament:<encounterId>:prepare|start`), de modo que cualquier reintento llega a la misma sala. Combat responde 422 con bloqueos si un participante no es elegible; Tournament los reenvía sin inventar participantes.

## Migraciones

1. `001-tournament-encounters`: publicada por PR #5, intacta (SHA-256 `2ca854efa1393c48e583045aeaad1dcc6b4d7fe19d43a45b74765a9a7090d7ae`). Conserva encounters, eventos, roster, resultado y paginación histórica.
2. `002-tournament-registration`: agrega `tournaments`, operaciones administrativas, equipos, pertenencias activas y operaciones de registro/pago. Restricciones de estado/cupo, cupo único, pertenencia única y exclusión global de calendario.
3. `003-tournament-bracket`: agrega snapshot y metadata nullable a encounters. Triggers comprueban roster, snapshot e identidad, impiden mutación y materializan catorce filas en la transacción de publicación. No recrea tablas de HU-83 ni incorpora `003-encounters` de la copia original.

4. `004-tournament-admin-actions` (HU-85): tabla `tournament_encounter_actions` con los recibos de preparar/iniciar (actor, justa, acción, fecha y sala). Solo de adición; únicos `(torneo, justa, acción)` y `(torneo, operación)`.

Preparación local: `npm ci`, `npm run build`, configurar PostgreSQL y `npm run migrate`; después arrancar con `npm start`. La composición no migra automáticamente. La instalación nueva aplica 001→002→003→004; una base publicada con 001 aplica 002→003→004. No hay importación automática desde el esquema incompatible sin publicar de la copia original. Las pruebas de actualización parten de 001 con roster, resultado y 120 eventos, comprueban preservación y páginas de 100+20.

## Administración de justas (HU-85)

Contrato: `Nexus-Battle-Infrastructure/docs/contracts/hu-85-tournament-encounter-administration-v1.md` (propuesta pendiente de revisión). Rutas bajo `/api/v1/tournaments/admin`, solo administradores, con el actor tomado del JWT:

- `POST /:tournamentId/matches/:matchId/prepare` y `POST /:tournamentId/matches/:matchId/start`, cuerpo `{operationId}`. `matchId` es el identificador completo de HU-83 (`<tournamentId>:E1`).
- `GET /:tournamentId/actions`: recibos en orden cronológico.

Cada justa se serializa por sí misma; no hay bloqueo de torneo ni dependencia de la transmisión. Repetir una acción devuelve el recibo original con `replayed:true`. Ausencias, calendario, reprogramación y cancelación no tienen regla aprobada y no se implementan. La verificación y sus límites se registran en `docs/hu-85-verificacion.md` (tarea HU-85.4).

## Verificación y límites

Ejecutar `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run test:coverage`, `npm run test:db` y `npm run build`. Se conserva el mínimo del 80 % en las dos suites. `test:db` usa PostgreSQL 17 mediante Testcontainers; alternativamente `TEST_DATABASE_URL` debe apuntar a un servidor local de pruebas con permiso `CREATE DATABASE`, donde cada prueba crea y elimina solo su base UUID propia.

Las suites verifican JWT/roles con verificador controlado, consentimiento, exclusión de miembros, rechazo/replay, dinero simulado durable sin datos de tarjeta, carreras por el octavo cupo, recuperación y compensación, calendario en ambos sentidos, siete/ocho confirmados, publicación concurrente, inmutabilidad, catorce justas y regresión/actualización HU-83. Account y Wallet se sustituyen por dobles explícitos o respuestas HTTP controladas en estas suites.

QA debe combinar las entregas reales de Account/Wallet/Tournament/Web, probar sesiones Cognito distintas, reanudación entre procesos con servicios reales, revisar la tabla funcional y validar el recorrido con usuarios. No se ha probado una sala o un combate real; HU-85, HU-80, premios, transmisión, publicación y despliegue quedan fuera de esta entrega local. Los resultados ejecutados y el commit están en `estado-tournament.json` de la coordinación.
