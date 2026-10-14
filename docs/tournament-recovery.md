# Torneos simultáneos y recuperación por inactividad

Decisión de producto del 14 de octubre de 2026: un administrador puede crear varios torneos, incluso con el mismo horario. Ya no se exige separación de 91 días. Se conservan la autorización administrativa, `opensAt < closesAt <= startsAt`, las ventanas personales de aceptación y la idempotencia de creación.

## Cierre sin campeón

El barrido automático cierra un torneo sin campeón después de treinta minutos sin actividad. El plazo comienza en el mayor instante entre `startsAt` y la última actividad real: una aceptación confirmada o un evento `battleStarted`, `basicAttackResolved` o `skillUsed` archivado desde Combat. Consultas, reintentos del worker, leases y turnos agotados no reinician el plazo. Un torneo futuro o con campeón confirmado queda excluido. Antes de evaluar la inactividad, el worker recupera los resultados disponibles de Combat.

El cierre conserva el bracket, los equipos, los consentimientos, los pagos originales, las batallas ya jugadas y su archivo. No crea un campeón, una derrota ni un premio. Las aceptaciones, publicaciones, preparaciones, inicios, confirmaciones de avance y entregas de premios posteriores se rechazan con `TOURNAMENT_CLOSED`. Las lecturas siguen disponibles.

`POST /api/v1/tournaments/admin/:id/close` permite cerrar administrativamente un torneo sin campeón, con JWT de administrador y cuerpo exclusivo `{ "operationId": "identificador-estable" }`. Repetir la solicitud conserva el cierre y los reembolsos. No sirve para cerrar un torneo que ya declaró campeón.

## Devoluciones

Los torneos gratuitos y pagados se cierran bajo la misma regla. Antes de llamar a Wallet se guarda el cierre y una intención de devolución por inscripción pagada. El destinatario y el importe proceden del pago original. Se reutiliza `entry:<teamId>:<paymentOperationId>:refund`, la misma operación de compensación del registro, para evitar devoluciones duplicadas entre workers o después de reiniciar.

Si se perdió la respuesta del cobro, se recupera su operación original antes de devolver. Solo se marca `REFUNDED` después de verificar el comprobante de Wallet, incluidos torneo, equipo, pagador, importe y cobro. Un timeout o un comprobante incorrecto mantiene la devolución `PENDING` para el siguiente barrido. El pago simulado se anula localmente; nunca movió dinero real.

La lista pública publica únicamente razón, fecha y conteos de devoluciones. La vista de inscripción devuelve los comprobantes de devolución únicamente al pagador autenticado. La inscripción original permanece como comprobante histórico.

## Historial personal

`GET /api/v1/tournaments/:id/matches/mine` devuelve las batallas del sujeto del JWT, usando el roster registrado o los participantes de Combat. `GET /api/v1/tournaments/:id/matches/mine/:matchId?afterSeq=0` verifica pertenencia antes de recuperar el detalle. Una batalla ajena devuelve 403; una referencia inexistente devuelve 404. La ruta antigua de detalle también restringe jugadores a sus encuentros; el administrador conserva acceso para revisar incidencias. La ruta de resumen permanece para las llaves y las vistas de transmisión.

## Actualización

La migración forward `012-tournament-closure` elimina la exclusión de calendario, agrega cierre y actividad, recupera actividad histórica y protege el cierre, las intenciones de devolución y el estado terminal. No modifica las migraciones anteriores ni vuelve a generar las llaves. Los cambios de ciclo de vida y aceptación se serializan con la fila padre del torneo para resolver las carreras con el cierre.

1. Publicar Combat con la gracia de entrada y reconexión de 120 segundos para salas de torneo. PvP normal conserva 30 segundos; turnos y límite de batalla conservan 30 segundos y seis minutos.
2. Ejecutar la migración 012 y desplegar Tournament actualizado. El primer barrido puede cerrar torneos antiguos inactivos y devolver sus inscripciones, como se autorizó para este cambio.
3. Publicar Web después de Tournament, porque su historial usa las nuevas rutas personales. Verificar que ambas imágenes incluyan previamente el soporte de piloto gratuito sin recompensas.
4. Comprobar readiness, crear un piloto gratuito y revisar el recorrido de ocho personas. Revisar el cierre del torneo antiguo y los reembolsos pendientes; no borrar datos ni asignar un ganador para desbloquearlo.

Los reinicios de Combat con MongoDB se validan en CI. Si el recorrido local usa Combat en memoria, su evidencia debe declararlo y no atribuirle persistencia de salas tras reinicio.
