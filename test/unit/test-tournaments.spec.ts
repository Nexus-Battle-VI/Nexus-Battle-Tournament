import { fixture, FREE_POLICY } from '../support/registration-fixture'
import type { CreateTournament } from '../../src/application/use-cases/Registrations'
import { Prizes } from '../../src/application/use-cases/Prizes'
import { InMemoryLifecycleRepository } from '../../src/adapters/outbound/persistence/InMemoryLifecycleRepository'

const command = {
  operationId: 'pilot',
  name: 'Piloto con personas',
  tournamentMode: 'SOLO' as const,
  entryPolicy: FREE_POLICY,
  opensAt: '2026-10-01T00:00:00Z',
  closesAt: '2026-10-10T00:00:00Z',
  startsAt: '2026-10-12T00:00:00Z',
}

describe('Piloto en producción sin afectar calendario ni cuentas', () => {
  it('permite repetir un piloto y conserva los 91 días entre torneos oficiales', async () => {
    const f = fixture(undefined, FREE_POLICY)
    await f.create('SOLO')
    const pilot = await f.registrations.create('admin', { ...command, isTest: true })
    expect(pilot.isTest).toBe(true)
    const second = await f.registrations.create('admin', {
      ...command,
      operationId: 'second-pilot',
      isTest: true,
    })
    expect(second.id).not.toBe(pilot.id)
    await expect(
      f.registrations.create('admin', {
        ...command,
        operationId: 'official-near',
      }),
    ).rejects.toMatchObject({ code: 'CALENDAR_CONFLICT' })
    const later = await f.registrations.create('admin', {
      ...command,
      operationId: 'official-later',
      startsAt: '2027-01-11T00:00:00Z',
    })
    expect(later.isTest).toBe(false)
  })

  it('las pruebas no ocupan fechas del calendario oficial', async () => {
    const f = fixture(undefined, FREE_POLICY)
    await f.registrations.create('admin', { ...command, isTest: true })
    expect((await f.create('SOLO')).isTest).toBe(false)
  })

  it('conserva el replay oficial al omitir isTest o enviarlo como false', async () => {
    const f = fixture(undefined, FREE_POLICY)
    const first = await f.registrations.create('admin', command)
    expect(await f.registrations.create('admin', { ...command, isTest: false })).toEqual(first)
    await expect(
      f.registrations.create('admin', {
        ...command,
        isTest: true,
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
  })

  it('rechaza un piloto de pago o con contrato antiguo', async () => {
    const f = fixture()
    await expect(
      f.registrations.create('admin', {
        ...command,
        isTest: true,
        entryPolicy: { version: 1, free: false, methods: [{ method: 'CREDITS', amount: 10 }] },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TEST_TOURNAMENT' })
    const legacy: CreateTournament = { ...command }
    delete legacy.tournamentMode
    await expect(
      f.registrations.create('admin', {
        ...legacy,
        isTest: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TEST_TOURNAMENT' })
  })

  it('registra una cuenta real elegible sin cobrar y no permite aprobar ni entregar premios', async () => {
    const f = fixture(undefined, FREE_POLICY)
    const pilot = await f.registrations.create('admin', { ...command, isTest: true })
    const team = await f.registrations.register(pilot.id, 'p0', {
      operationId: 'register-pilot',
      name: 'Carlos',
      invitedMemberIds: [],
      avatar: { kind: 'ACCOUNT_AVATAR', subject: 'p0' },
    })
    const entered = await f.registrations.enter(pilot.id, team.id, 'p0', {
      operationId: 'enter-pilot',
    })
    expect(entered).toMatchObject({
      status: 'CONFIRMED',
      entryReceipt: { payment: { method: 'FREE' } },
    })
    expect(f.accounts.eligible.mock.calls).toContainEqual(['p0'])
    expect(f.wallet.debits).toBe(0)
    const grant = jest.fn()
    const prizes = new Prizes(new InMemoryLifecycleRepository(), f.repo, { grant }, f.clock)
    await expect(prizes.approve(pilot.id, 'admin', {})).rejects.toMatchObject({
      code: 'TEST_TOURNAMENT_NO_PRIZES',
    })
    await expect(prizes.deliver(pilot.id, 'admin')).rejects.toMatchObject({
      code: 'TEST_TOURNAMENT_NO_PRIZES',
    })
    expect(grant).not.toHaveBeenCalled()
    await expect(
      f.repo.change(pilot.id, (t) => {
        t.isTest = false
      }),
    ).rejects.toMatchObject({ code: 'IMMUTABLE_TOURNAMENT_CONFIGURATION' })
  })
})
