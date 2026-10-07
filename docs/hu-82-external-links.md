# HU-82: enlaces externos por torneo

Adición sobre PR Tournament #7 (`7e094741c7b60a4973e6cfa758929ed22a251925`), conservando `torneos-hu77-84-78-hu83-v2.0.0`. Consume la propuesta Infrastructure `torneos-cierre-observacion-enlaces-v0.1.0.md`; falta acuse Web antes de congelarla.

`GET /api/v1/tournaments/:id/links` exige JWT y devuelve `{tournamentId,liveUrl,youtubeArchiveUrl,revision,updatedAt}`. `PUT /api/v1/tournaments/admin/:id/links` exige ADMINISTRATOR (incluye SUPER_ADMINISTRATOR) y ambos enlaces más `expectedRevision`. Usa RegistrationRepository vigente; no requiere bracket ni HU-85. El alcance administrativo es el existente, sin inventar un ACL de organizadores.

La pareja se valida antes de guardar: HTTPS absoluto, hosts/rutas públicos YouTube/Twitch definidos, archivo de canal YouTube, sin claves, credenciales ni destinos de Studio. Enlaces null significan no publicados. 400 para cuerpo inválido, 401/403 por identidad/permiso, 404 para torneo inexistente, 422 LINKS_INVALID y 409 LINKS_CHANGED. Repetir contenido conserva revisión y fecha, incluso con revisión antigua. Contenido distinto exige la revisión actual.

Migración reservada `008-tournament-external-links`: tabla propia con FK al torneo de inscripción, validación SQL y revisión monotónica. Se conservan intactas 001/002/003. Una transacción bloquea el torneo durante la edición; no hay llamadas externas ni vídeo almacenado. Una URL guardada no acredita emisión activa, titularidad del canal ni archivo disponible.

Pruebas incluidas: dominio, HTTP con guards reales y verificador JWT controlado, dos pools PostgreSQL concurrentes, rollback, reinicio de pool, instalación limpia y upgrade de datos HU-83/registro/bracket sin borrar tablas. Comandos: lint, format:check, typecheck, test:coverage, test:db, build. Resultados y SHA comprobados se registran en estado/chat-02.json; el código de pruebas por sí solo no acredita que se hayan ejecutado.

Pendientes: integración de Web, identidades Cognito reales y emisión/archivo público EN-033. No se declara aceptación funcional de HU-82.
