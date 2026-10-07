import type { RegistrationTournament } from '../../src/domain/registration'
import type { RegistrationRepository } from '../../src/application/ports/RegistrationPorts'
import { fixture } from './registration-fixture'

/** Fixtures controladas de consumo; no representan salas, campeones o canales operativos. */
export const bracketClock = { now: () => new Date('2026-10-05T12:00:00.000Z') }
export const tournamentFixture = (
  id = 'T1',
  startsAt = '2026-10-12T00:00:00.000Z',
): RegistrationTournament => ({
  id,
  name: 'Copa de prueba',
  entryPolicy: { version: 1, free: true, methods: [] },
  entryFee: 0,
  opensAt: '2026-10-01T00:00:00.000Z',
  closesAt: '2026-10-10T00:00:00.000Z',
  startsAt,
  bracket: null,
  teams: [],
  operations: {},
})
export const registrationService = (repository: RegistrationRepository) =>
  fixture(repository).registrations
