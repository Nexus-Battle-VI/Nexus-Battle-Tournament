/**
 * Simbolos de inyeccion de los casos de uso de HU-83, en su propio fichero
 * para que tanto el controlador como `app.module.ts` lo importen sin crear un
 * ciclo entre ambos (mismo patron que `tokens.health.ts`).
 */
export const LIST_TOURNAMENT_MATCHES = Symbol('ListTournamentMatches')
export const GET_TOURNAMENT_MATCH_DETAIL = Symbol('GetTournamentMatchDetail')
