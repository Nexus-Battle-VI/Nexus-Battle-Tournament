# Arquitectura de Tournament

Fuente de la decisión: [ADR-022](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-022-sprint-3-bounded-contexts.md).
Este documento distingue el incremento local HU-77/84/78/83 del ciclo de vida previsto. API, migraciones y límites del incremento: [torneos-v2.md](torneos-v2.md). La referencia común es `torneos-hu77-84-78-hu83-v2.0.0` en `Nexus-Battle-Infrastructure/docs/contracts`.

## Responsabilidad

Gestiona el ciclo de vida completo del torneo, que dura semanas y abarca muchas batallas:

- quién se inscribe y quién paga;
- qué cupo ocupa cada equipo;
- qué justa se juega después y quién avanza;
- quién es campeón y cuándo recibe su premio.

**La batalla de cada justa la juega Combat.** Tournament crea la sala y recibe el resultado; no reimplementa reglas de combate ni aleatoriedad.

## Datos que posee

- **Torneos**: fecha, estado y administrador que los crea. Solo se permite uno cada 91 días (§7.9 del documento oficial).
- **Equipos inscritos**: exactamente dos jugadores distintos. Account valida nombre y avatar de un integrante; el compañero acepta desde su propia sesión. Estados: `AWAITING_CONSENT`, `PENDING_PAYMENT`, `PAYMENT_PENDING`, `COMPENSATING`, `CONFIRMED`, `CANCELLED`.
- **Inscripciones y pagos de cupo**, con su `operationId`.
- **Bracket** de ocho equipos humanos `CONFIRMED` y dieciséis jugadores distintos. La HU-78 vigente excluye IA y reemplaza la regla antigua del sprint. Tiene dos árboles:

  | Árbol       | Encuentros                          |
  | ----------- | ----------------------------------- |
  | Ganadores   | E1, E2, E3, E4, E5, E6, E11 y final |
  | Secundarios | E7, E8, E9, E10, E12 y E13          |

- **Justas**: vinculadas a una sala de Combat, con estado y resultado confirmado.
- **Entrega de premios**: créditos y recompensa épica, reanudable si falla a mitad.

Motor: **PostgreSQL**, base lógica `tournament` con usuario y credenciales propios en el nodo de datos.

## Invariantes que debe imponer el motor

- **El octavo cupo lo gana como mucho un equipo.** La confirmación de cupo bloquea el torneo con `SELECT ... FOR UPDATE`. El equipo que pierde la carrera no queda cobrado.
- **Un jugador no está en dos equipos del mismo torneo**: índice único.
- **Inicios separados por 91 × 24 horas**: comparación global de `startsAt` UTC en ambos sentidos, protegida por restricción de exclusión SQL. La frontera exacta de 91 días es válida.
- **Un resultado por justa**: confirmar dos veces devuelve el mismo resultado. Un resultado de otra sala se rechaza.
- **Un premio por campeón**: `operation_id` único por entrega.
- Importes `bigint` y estrictamente positivos. Nunca coma flotante para dinero.

## Integraciones

| Tournament →     | Para qué                                                                   | Modo                            |
| ---------------- | -------------------------------------------------------------------------- | ------------------------------- |
| Account          | Validar que los miembros existen y están activos                           | Síncrono                        |
| Wallet           | Cobrar la inscripción, reembolsar, abonar el premio                        | Síncrono, `operationId`         |
| Player/Inventory | Compromiso `TOURNAMENT` del héroe y entrega de la épica                    | Síncrono, `operationId`         |
| Combat           | Crear la sala de una justa con participantes fijos; consultar su resultado | Síncrono, `operationId` = justa |
| Notifications    | Avisos de inscripción, próxima justa y resultado                           | Asíncrono, por ingesta HTTP     |

**Entrada interna prevista** (`/api/internal/v1/tournaments/...`, HMAC): Combat notifica el resultado de una sala vinculada a una justa. Hoy no hay ningún consumidor autorizado (`INTERNAL_CALLERS = []`).

Las llamadas salientes que mueven créditos o productos siguen el patrón de ADR-019:

1. Persistir la intención con un `operationId` antes de llamar.
2. Reservar o cobrar en el dueño del recurso con ese `operationId`.
3. Confirmar o compensar según el resultado del propio agregado.
4. `409` y `503` no autorizan a suponer que la operación no ocurrió: se reintenta con el mismo `operationId`.

## Historias de Usuario

| HU    | Historia                                                                                                                    |
| ----- | --------------------------------------------------------------------------------------------------------------------------- |
| HU-77 | [Registro del equipo para participar en un torneo](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/467)   |
| HU-84 | [Confirmación del cupo mediante pago de inscripción](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/468) |
| HU-78 | [Bracket de ocho equipos con doble árbol](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/469)            |
| HU-85 | [Administración e inicio de justas](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/470)                  |
| HU-80 | [Confirmación de resultados y avance](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/471)                |
| HU-86 | [Entrega de créditos y recompensa épica al campeón](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/472)  |
| HU-83 | [Registro de todas las justas](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/465)                       |
| HU-79 | [Preparar una justa para transmisión externa](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/462)        |
| HU-81 | [Cambiar la justa mostrada](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/463)                          |
| HU-82 | [Publicar el acceso externo al directo y al archivo](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/464) |

## Temporizadores

El incremento usa reconciliadores cada cinco segundos para pagos/compensaciones y registros de salas ya vinculadas. Las intenciones y cursores viven en PostgreSQL; los bloqueos por torneo y las operaciones idempotentes permiten reanudar después de un reinicio. No hay caducidad inventada del cupo confirmado. La hora la fija el servidor. El driver `memory` es un doble y está prohibido en producción.

## Decisiones abiertas (Product Owner)

- **Formato de la justa.** El documento dice «equipos de dos jugadores con un máximo de seis por batalla». Combat solo admite dos equipos iguales de 1 a 3.
- Importes concretos de cada torneo: los configura el administrador mediante `entryPolicy`. El contrato v2 fija pago por el creador y compensación tras cierre; `SIMULATED_MONEY` no mueve dinero real.
- Reparto del premio entre los dos miembros, fuera del incremento.
- Empates, incomparecencias, reprogramación y corrección de resultados.
- La tabla E1–E13/Final del contrato v2 se conserva como snapshot; su revisión funcional sigue pendiente. No habilita avance automático HU-80. La separación se calcula sobre `startsAt`, no sobre la apertura.
