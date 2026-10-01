# Arquitectura de Tournament

Fuente de la decisión: [ADR-022](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-022-sprint-3-bounded-contexts.md).
Este documento describe lo **previsto**. Los contratos exactos se publican como OpenAPI en `Nexus-Battle-Infrastructure/docs/contracts` antes de implementarse.

## Responsabilidad

Gestiona el ciclo de vida completo del torneo, que dura semanas y abarca muchas batallas:

- quién se inscribe y quién paga;
- qué cupo ocupa cada equipo;
- qué justa se juega después y quién avanza;
- quién es campeón y cuándo recibe su premio.

**La batalla de cada justa la juega Combat.** Tournament crea la sala y recibe el resultado; no reimplementa reglas de combate ni aleatoriedad.

## Datos que posee

- **Torneos**: fecha, estado y administrador que los crea. Solo se permite uno cada 91 días (§7.9 del documento oficial).
- **Equipos inscritos**: exactamente 2 jugadores distintos, con nombre y avatar según la política de registro de HU-01. Estados: pendiente de pago y confirmado.
- **Inscripciones y pagos de cupo**, con su `operationId`.
- **Bracket** de 8 cupos. Los cupos vacíos los ocupan equipos de IA. Tiene dos árboles:

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
- **Un torneo cada 91 días**: restricción sobre las fechas de los torneos.
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

Los vencimientos (por ejemplo, cupos pendientes de pago) usan un intervalo dentro del proceso, apagado por defecto, con reclamación durable en el almacén (`FOR UPDATE SKIP LOCKED`). El estado vive en la base: un reinicio retrasa un vencimiento, no lo pierde. La hora la fija siempre el servidor.

## Decisiones abiertas (Product Owner)

- **Formato de la justa.** El documento dice «equipos de dos jugadores con un máximo de seis por batalla». Combat solo admite dos equipos iguales de 1 a 3.
- Importe de la inscripción, quién la paga y reembolsos. El documento acepta «dinero real o créditos»; HU-84 habla de pasarela simulada.
- Reparto del premio entre los dos miembros, y qué ocurre si gana un equipo de IA.
- Empates, incomparecencias, reprogramación y corrección de resultados.
- Tabla exacta de origen y destino del bracket, y desde qué fecha cuentan los 91 días.
- **Los equipos de IA dependen de JcE en Combat**, que todavía no tiene HU.
