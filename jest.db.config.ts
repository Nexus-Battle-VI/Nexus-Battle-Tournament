import type { Config } from 'jest'

/**
 * Pruebas que necesitan una base de datos real, en su propia configuracion.
 *
 * Levantan PostgreSQL 17 con Testcontainers, o usan TEST_DATABASE_URL para crear
 * bases aisladas en un servidor de pruebas con permiso CREATE DATABASE.
 * Meterlas en la suite
 * por defecto obligaria a tener Docker a cualquiera que ejecute `npm test`, y
 * quien trabaja en el dominio o en los casos de uso no deberia necesitarlo.
 *
 * El CI ejecuta ambas: `npm test` y `npm run test:db`.
 */
const config: Config = {
  rootDir: '.',
  displayName: 'db',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['<rootDir>/test/db/**/*.spec.ts'],
  // Descargar y arrancar la imagen la primera vez supera el limite por defecto.
  testTimeout: 120_000,

  // Esta suite mide SU propia superficie: los adaptadores de PostgreSQL y la
  // infraestructura de persistencia, que la suite por defecto no puede ver.
  collectCoverageFrom: [
    'src/adapters/outbound/persistence/Postgres*.ts',
    'src/infrastructure/persistence/**/*.ts',
    '!src/infrastructure/persistence/migrate.ts',
  ],
  coverageDirectory: 'coverage-db',
  coverageReporters: ['text-summary'],
  coverageThreshold: {
    global: { branches: 80, functions: 80, lines: 80, statements: 80 },
  },
}

export default config
