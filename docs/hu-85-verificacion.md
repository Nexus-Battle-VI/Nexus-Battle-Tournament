# HU-85 — Verificación de simultaneidad, elegibilidad e inicio único

Fuente: [HU-85.4 #488](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/488). Contrato verificado: `hu-85-tournament-encounter-administration-v1` (Infraestructura, **propuesta pendiente de revisión por los responsables**: nada de lo que sigue la presenta como aprobada).

Estado de las tareas de HU-85 al redactar este informe: contrato HU-85.1 (Infrastructure #200) y backend HU-85.2 (Tournament #9) fusionados; Web HU-85.3 en revisión (Web #219). Combat se verificó con su `develop` del 2026-10-07 (incluye EN-036.2 y EN-036.3, que no tocan las rutas de torneo).

## Qué es real y qué es de prueba

| Capa                                                  | Pruebas locales (`jest`, `test/integration` y `test/db`)                           | Contra Combat real (`real-combat-hu85.spec.ts`)              |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Tournament: rutas, guards, validación, casos de uso   | **Reales** (módulo Nest completo)                                                  | **Reales** (casos de uso)                                    |
| Autenticación                                         | JWT con verificador controlado (roles simulados)                                   | No aplica (llamada directa a los casos de uso)               |
| Persistencia de Tournament                            | En memoria (`integration`) y **PostgreSQL real** aislado en contenedor (`test/db`) | En memoria                                                   |
| Cliente HTTP de escritura y firma HMAC                | Prueba unitaria con `fetch` simulado                                               | **Reales**                                                   |
| Combat                                                | **Doble de prueba** (`test/support/fake-combat.ts`), solo replica el contrato      | **Proceso real** `node dist/main.js` de Combat `develop`     |
| Account y Player-Inventory (los llama Combat)         | No se usan                                                                         | **Dobles de prueba** locales mínimos que no validan la firma |
| Cognito, Wallet, Notificaciones, PostgreSQL de Combat | No probados                                                                        | No probados (Combat usa su persistencia en memoria)          |

Además, `test/db/real-combat-postgres-hu85.spec.ts` ejecuta el recorrido completo por HTTP con el módulo Nest real de Tournament configurado solo por variables de entorno (`COMBAT_BASE_URL`, `INTERNAL_SERVICE_AUTH_SECRET`, `DATABASE_URL`), **PostgreSQL real en Docker con todas las migraciones** y **Combat real**. Sus dobles son los JWT, Account/Wallet de registro (para crear el torneo y el bracket) y Account/Inventory de Combat. Cubre C1–C4 y C6–C8 de punta a punta, con dos administradores y recibos en la tabla `tournament_encounter_actions`.

Ninguna prueba demuestra el comportamiento en producción ni con usuarios reales.

## Cómo repetir

```bash
# Tournament: unidad + HTTP (incluye el doble de Combat)
npm test
# Tournament: PostgreSQL real (requiere Docker abierto)
npx jest --config jest.db.config.ts --runInBand
# Combat real: compilar Combat una vez y apuntar a su carpeta
(cd ../Nexus-Battle-Combat && npm ci && npm run build)
HU85_REAL_COMBAT_DIR=../Nexus-Battle-Combat npx jest --selectProjects integration test/integration/real-combat-hu85.spec.ts
# Combat real + PostgreSQL en Docker + módulo Nest real (Docker abierto)
HU85_REAL_COMBAT_DIR=../Nexus-Battle-Combat npx jest --config jest.db.config.ts --runInBand test/db/real-combat-postgres-hu85.spec.ts
```

Sin `HU85_REAL_COMBAT_DIR` el archivo de Combat real se omite (queda como «skipped», no como aprobado).

## Casos: esperado vs observado

Resultado observado en la última ejecución local el 2026-10-06. «Local» = doble de Combat; «Real» = Combat real.

| Caso                                         | CA          | Esperado                                                                                           | Observado local                                           | Observado real                                                                                                                             |
| -------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 Preparar E1 con equipos resueltos         | CA-01       | Una sala vinculada, `READY/PREPARED`, recibo con actor, justa, acción y fecha                      | Cumple (HTTP y PostgreSQL)                                | Cumple: sala UUID de Combat, equipos y héroes proyectados desde su registro                                                                |
| C2 Iniciar E1 preparada                      | CA-01       | Misma sala, `IN_PROGRESS/IN_BATTLE`, `startedAt` de Combat                                         | Cumple                                                    | Cumple                                                                                                                                     |
| C3 E1 y E2 a la vez                          | CA-02       | Salas distintas, ambas en batalla, sin esperar al resto ni a la transmisión                        | Cumple (HTTP, dos administradores)                        | Cumple                                                                                                                                     |
| C4 Semifinal E5 sin participantes            | CA-03       | 409 `PARTICIPANTS_UNRESOLVED`; sin sala, equipos ni ganador; sin llamar a Combat                   | Cumple                                                    | Cumple: cero llamadas a Account/Inventory/Combat                                                                                           |
| C5 Cuenta no administradora / sin sesión     | CA-03       | 403 / 401; Combat no se toca; sin recibo                                                           | Cumple (HTTP)                                             | No aplica                                                                                                                                  |
| C6 Combat rechaza a un participante          | CA-03       | 422 `COMBAT_REJECTED_PARTICIPANTS` con bloqueos; sin sala vinculada ni recibo; se puede reintentar | Cumple                                                    | Cumple (jugador sin héroe equipado: 422 de Combat real)                                                                                    |
| C7 Repetir el mismo inicio                   | CA-04       | Mismo recibo, `replayed:true`, un solo combate                                                     | Cumple                                                    | Cumple                                                                                                                                     |
| C8 Iniciar con otro `operationId`            | CA-04       | Misma sala, un solo recibo `START`                                                                 | Cumple                                                    | Cumple                                                                                                                                     |
| C9 Dos inicios/preparaciones concurrentes    | CA-04       | Misma sala y un solo recibo                                                                        | Cumple (en memoria y con dos instancias sobre PostgreSQL) | Cumple: dos instancias del servicio compiten contra Combat real y obtienen una sola sala y un solo recibo por acción                       |
| C10 Combat caído y recuperado                | CA-01/CA-04 | 503 sin estado; el reintento llega a la misma sala                                                 | Cumple                                                    | Cumple: Combat inalcanzable (puerto cerrado) da 503 sin cambiar nada; el reintento llega a una sola sala. No se detuvo un Combat en marcha |
| C10b Respuesta perdida tras crear la sala    | CA-04       | El reintento reutiliza la sala                                                                     | Cumple                                                    | Cumple por igualdad de sala tras «reiniciar» Tournament con recibos vacíos                                                                 |
| C11 Mismo `operationId` en otra justa/acción | CA-03       | 409 `OPERATION_CONFLICT`                                                                           | Cumple                                                    | Cumple: otra justa con el mismo `operationId` da 409; Combat real responde 409 al mismo `operationId` con otro cuerpo                      |
| C12 Iniciar sin preparar                     | CA-03       | 409 `ENCOUNTER_NOT_PREPARED`; sin llamar a Combat                                                  | Cumple                                                    | Cumple: 409 sin llamar a Combat; Combat real responde 409 a un inicio de sala inexistente                                                  |
| C13 Paso del tiempo sin iniciar              | CA-03       | Sin derrota, ganador ni cierre automáticos; nada pasa a `FINISHED` por ausencia                    | Cumple (HTTP)                                             | Cumple: un año después iniciar no fija resultado ni cierre y el registro de Combat sigue sin resultado                                     |

La base de datos impide por sí misma duplicar recibos (acción por justa y `operationId`), acciones inválidas y justas inexistentes (prueba `test/db/encounter-admin.spec.ts`).

## Comprobaciones del lado del servidor

- El actor sale del `sub` verificado del JWT; el cuerpo solo acepta `operationId` (otros campos devuelven 400).
- El rol administrador se exige en las tres rutas antes de leer o tocar nada.
- Los equipos que se envían a Combat salen del snapshot inmutable del bracket, nunca de la solicitud.
- Combat decide la elegibilidad final (héroe equipado y bloqueos); Tournament reenvía sus bloqueos sin inventar participantes ni ganador.

## Decisiones de negocio NO aprobadas

Siguen sin regla aprobada y esta entrega **no** las implementa: reprogramación, cancelación y reacción a fechas vencidas (la regla firme de la HU, sin derrotas ni ganadores automáticos, sí se cumple y se prueba en C13); tamaño de equipo (2 vs hasta 6); auditoría de intentos rechazados. El contrato las marca como pendientes.

## Qué no se verificó

Cognito real y roles reales; Account e Inventory reales (Combat los consume como dobles); Wallet y premios; transmisión; despliegue real (el compose de Infrastructure en `develop` ya declara `COMBAT_BASE_URL`, `ACCOUNT_BASE_URL` y `WALLET_BASE_URL` para `tournament`; no se desplegó); Combat con persistencia real; el avance del bracket (HU-80).
