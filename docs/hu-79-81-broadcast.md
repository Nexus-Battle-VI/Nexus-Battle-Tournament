# HU-79/81: observación y selección por torneo

Adición sobre progreso/premios, con TournamentMatchReadPort del archivo HU-83 vigente. El controlador GET /matches original conserva su array. `matchId` y `selectedMatchId` son ids opacos; E1/E2 se muestran en bracketLabel. `combatRoomId`, IN_PROGRESS, lastSyncedSeq y events.payload se traducen explícitamente; no se importa Encounters antiguo ni se prepara/inicia una sala.

Consume la propuesta Infrastructure observacion-enlaces v0.1.0. JWT y rol administrativo en las rutas de observación; además solo el administrador designado por torneo puede consultar activas, capturar y seleccionar. Una sustitución explícita con revisión revoca al anterior conservando la selección. Identidad y permiso proceden del token, sin actor/rol desde el cuerpo. No se añade un rol global ni ACL de organizadores inexistente.

Rutas: GET admin `admin/:id/broadcast`, POST admin `admin/:id/broadcast/designate`; GET `:id/broadcast/active`, GET `:id/broadcast/view`, POST `:id/broadcast/selection` con `{matchId,expectedRevision}`. Las lecturas llevan no-store. 401/403/404/409/503 conforme al contrato propuesto. La fuente se consulta fuera del lock SQL; permiso/revisión se comprueban antes y después.

Solo se cambia a una justa IN_PROGRESS del mismo torneo. Primero se valida el nuevo snapshot; un fallo conserva el anterior. Un encuentro seleccionado terminado permanece hasta decisión del operador. Una respuesta tardía E1 tras seleccionar E2 se rechaza por revisión, igual que una lectura completada después de revocar al transmisor. Web aún debe validar generación/id/sala/revisión/cursor al recibir una respuesta.

La vista publica exclusivamente identificación, equipos, héroes, vida, poder, turno, última acción y resultado reducidos. Construye una lista explícita de campos a partir de payload.battle validado contra sala/miembros/cursor. No expone wire libre, semillas, tokens, auditorías ni comandos. Datos estructurales incompatibles son 503 OBSERVATION_INVALID; un medidor legítimamente ausente es null. Seleccionar u observar no cambia otros combates.

009-tournament-broadcast se registra después de las migraciones de modalidad, aceptación y enlaces. La proyección exige dos lados de teamSize 1/2/3 y conserva 2/4/6 combatientes, incluido el tercer asiento TRIO. Las pruebas usan el migrador operativo compuesto; una base sin la tabla devuelve 503 BROADCAST_PERSISTENCE_UNAVAILABLE.

Pruebas incluidas: transmisor concurrente/revisión/sustitución, id opaco, redacción de datos, E1→E2, respuestas tardías, revocación durante lectura, rechazo sin perder selección, final/reconexión y dos pools con reinicio. HTTP usa guards reales con verificador JWT controlado. Los combates/estados son fixtures; no acreditan HU-85, OBS, voz, directo ni archivo EN-033 reales. Resultados/SHA en estado/chat-02.json.

Pendientes de validación de producto: emisión externa y archivo con justas reales simultáneas. La preparación de captura y guardar enlaces no prueban emisión activa. No se cierra HU-79/81 por estas suites.
