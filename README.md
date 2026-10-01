# Nexus-Battle-Tournament

Servicio de Nexus Battles VI para el bounded context **Tournament**: torneos, equipos inscritos, inscripciones, bracket, justas y premios.

Gestiona el ciclo de vida completo de un torneo: inscripción y pago del cupo, bracket de ocho equipos con árbol de ganadores y de secundarios, inicio de justas, avance según resultados y entrega del premio al campeón. **La batalla de cada justa la juega Combat**: este servicio crea la sala y recibe el resultado, sin reimplementar reglas de combate.

Este repositorio contiene código y Pull Requests. No contiene Issues ni Product Backlog: la fuente única de verdad es [Nexus-Battle-Management](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management).

- **Decisión que lo crea:** [ADR-022](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-022-sprint-3-bounded-contexts.md) (`Accepted`)
- **Épica:** [EPIC-09 Torneo](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/9)
- **Teams propietarios:** Team Beta y Team Gama
- **Arquitectura interna:** Clean + Hexagonal ([ADR-002](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-002-backend-stack.md))
- **Base de datos:** PostgreSQL, propia y exclusiva ([ADR-005](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-005-data-strategy.md))
- **Puerto:** 3010
- **Ruta pública:** `/api/v1/tournaments*`, con las rutas de administración bajo el mismo prefijo (`/api/v1/tournaments/admin/...`)

## Estado

**Andamiaje.** Arranca, verifica identidad, firma y comprueba el contrato interno, expone sus sondas y conecta con su base.

**No tiene todavía ninguna ruta de negocio ni ninguna tabla**: las añade cada Historia de Usuario. Mientras tanto, cualquier ruta bajo ese prefijo responde `404` desde NestJS.

## Qué posee este contexto

- Torneos y su calendario (uno cada 91 días).
- Equipos inscritos de dos jugadores, con nombre y avatar.
- Inscripciones y pagos de cupo, con su `operationId`.
- Bracket de 8 cupos, con relleno por equipos de IA.
- Justas vinculadas a una sala de Combat y su resultado confirmado.
- Entrega de premios al campeón, reanudable.

Ningún otro servicio accede a este almacén, ni directamente ni con claves foráneas.

## Historias de Usuario que viven aquí

HU-77, HU-84, HU-78, HU-85, HU-80, HU-86, HU-83, HU-79, HU-81 y HU-82, de la [EPIC-09](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/9). EN-033 (canal y emisión externa) es operación, no código. Detalle y orden en [docs/architecture.md](docs/architecture.md).

## Integraciones previstas

- **Salida** (síncrona, con `operationId`): Account (miembros), Wallet (inscripción y premio en créditos), Player/Inventory (compromiso `TOURNAMENT` y épica) y Combat (sala de cada justa).
- **Entrada interna** (`/api/internal/v1/tournaments/...`, HMAC): Combat notificará el resultado de una sala vinculada a una justa. Hoy no hay consumidores autorizados.
- **Avisos:** Notifications, por su ingesta HTTP.

## Estructura

```text
src/
  domain/            Entidades, objetos de valor, políticas y eventos
  application/       Casos de uso, puertos, DTO y errores
  adapters/
    inbound/http/    Controladores, DTO HTTP y guards
    outbound/        Persistencia, identidad, clientes de otros servicios
  infrastructure/    config, observabilidad, salud, persistencia y composición
```

El dominio no importa NestJS, drivers ni adaptadores, y la aplicación depende solo de sus puertos: lo impide ESLint en CI. Los casos de uso son clases sin decoradores registradas con fábricas en `src/infrastructure/bootstrap/app.module.ts`.

## Verificación local

```bash
npm ci
npm run lint
npm run format:check
npm run typecheck
npm run test:coverage
npm run test:db        # requiere Docker: levanta PostgreSQL con Testcontainers
npm run build
```

Cobertura mínima del **80 %** en ambas suites; por debajo, el comando falla.

## Configuración

Ver [.env.example](.env.example). Las reglas que hacen fallar el arranque son deliberadas:

| Situación                                             | Resultado                |
| ----------------------------------------------------- | ------------------------ |
| `NODE_ENV=production` con `AUTH_MODE=disabled`        | **No arranca** (ADR-004) |
| `NODE_ENV=production` con `PERSISTENCE_DRIVER=memory` | **No arranca** (ADR-022) |
| `PERSISTENCE_DRIVER=postgres` sin `DATABASE_URL`      | **No arranca**           |
| `AUTH_MODE=jwt` sin pool o cliente                    | **No arranca**           |

## Identidad y autorización

- **Toda ruta nace protegida.** El guard es global; abrir una ruta exige `@Public()`.
- La identidad sale del token de acceso verificado contra el JWKS del pool (`aws-jwt-verify`), nunca del cuerpo ni de la URL.
- `@Roles(...)` restringe por rol; `SUPER_ADMINISTRATOR` satisface lo que se exige a `ADMINISTRATOR`, y no al revés.
- Las rutas `@InternalOnly()` exigen firma HMAC-SHA256 (`x-internal-service`, `x-internal-timestamp`, `x-internal-signature`) de un servicio de la lista `INTERNAL_CALLERS`. Sin secreto configurado responden `503`. Caddy bloquea `/api/internal*` desde fuera.

## Sondas

| Ruta                    | Semántica                                     |
| ----------------------- | --------------------------------------------- |
| `GET /api/health/live`  | El proceso responde. No consulta dependencias |
| `GET /api/health/ready` | Hace ping a PostgreSQL. `503` si no responde  |
| `GET /api/version`      | Servicio, versión y entorno                   |

## Ramas

`main` y `develop` están protegidas. Todo Pull Request va a **`develop`**; `main` solo recibe la promoción completa de `develop`, y el workflow `Flujo de ramas` lo hace cumplir. Ver [CONTRIBUTING.md](CONTRIBUTING.md).

## Licencia

Licensing pending project governance.
