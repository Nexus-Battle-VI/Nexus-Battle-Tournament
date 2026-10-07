import { fixture, FREE_POLICY, MIXED_POLICY, CARD } from '../support/registration-fixture'
import { teamMemberIds, type TournamentMode } from '../../src/domain/registration'
import { InMemoryLifecycleRepository } from '../../src/adapters/outbound/persistence/InMemoryLifecycleRepository'
import { Progressions } from '../../src/application/use-cases/Progressions'
import { ControlledMatchRead, matchFixture } from '../support/match-read-fixture'

describe('Modalidades configuradas, consentimientos y pago único por equipo', () => {
  it.each(['SOLO', 'DUO', 'TRIO'] as TournamentMode[])(
    'publica ocho equipos %s y roster único',
    async (mode) => {
      const f = fixture(undefined, FREE_POLICY),
        t = await f.create(mode)
      const size = mode === 'SOLO' ? 1 : mode === 'DUO' ? 2 : 3
      expect(t.teamSize).toBe(size)
      for (let n = 0; n < 8; n++) {
        const owner = 'owner' + String(n)
        const invites = Array.from(
          { length: size - 1 },
          (_, i) => `invite${String(n)}-${String(i)}`,
        )
        const team = await f.registrations.register(t.id, owner, {
          operationId: 'r' + String(n),
          name: 'Equipo ' + String(n),
          avatar: { kind: 'ACCOUNT_AVATAR', subject: owner },
          invitedMemberIds: invites,
        })
        expect(teamMemberIds(team)).toEqual([owner, ...invites])
        expect(team.companionId).toBe(size === 2 ? invites[0] : null)
        for (const invited of invites)
          await f.registrations.consent(t.id, team.id, invited, 'c' + invited, true)
        await f.registrations.enter(t.id, team.id, owner, { operationId: 'p' + String(n) })
      }
      const before = await f.repo.read(t.id)
      const bracket = await f.brackets.publish(t.id, 'admin', 'publish')
      expect(bracket.version).toBe(3)
      expect(new Set(bracket.seeds.flatMap((s) => s.memberIds)).size).toBe(size * 8)
      expect(bracket.matches.every((m) => m.encounterId !== m.id)).toBe(true)
      expect((await f.registrations.view(t.id, 'owner0')).capacity).toMatchObject({
        confirmedPeople: size * 8,
        available: 0,
      })
      const state = new InMemoryLifecycleRepository(),
        source = new ControlledMatchRead()
      const progress = new Progressions(state, f.repo, source, f.clock, f.encounters)
      for (const label of ['E2', 'E1', 'E4', 'E3'] as const) {
        const e = matchFixture(bracket, label)
        source.items.set(e.encounterId, e)
        await progress.confirm(t.id, e.encounterId)
      }
      const e5 = bracket.matches.find((m) => m.id === 'E5')!
      expect(
        (await f.encounters.findOne(t.id, e5.encounterId))!.bracketMetadata!.registeredTeams.every(
          (s) => s?.memberIds.length === size,
        ),
      ).toBe(true)
      expect((await progress.view(t.id)).champion).toBeNull()
      expect((await f.repo.read(t.id)).teams).toEqual(before.teams)
      expect((await f.repo.read(t.id)).bracket).toEqual(bracket)
    },
  )
  it('TRIO exige ambos consentimientos y todas las cuentas elegibles; el creador paga una vez', async () => {
    const f = fixture(),
      t = await f.create('TRIO')
    const input = {
      operationId: 'register',
      name: 'Trío',
      invitedMemberIds: ['a', 'b'],
      avatar: { kind: 'ACCOUNT_AVATAR' as const, subject: 'owner' },
    }
    const team = await f.registrations.register(t.id, 'owner', input)
    await f.registrations.consent(t.id, team.id, 'a', 'consent-a', true)
    await expect(
      f.registrations.enter(t.id, team.id, 'owner', { operationId: 'pay' }),
    ).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' })
    await expect(
      f.registrations.consent(t.id, team.id, 'outsider', 'forge', true),
    ).rejects.toMatchObject({ status: 403 })
    await f.registrations.consent(t.id, team.id, 'b', 'consent-b', true)
    await expect(
      f.registrations.enter(t.id, team.id, 'a', { operationId: 'pay' }),
    ).rejects.toMatchObject({ status: 403 })
    f.accounts.eligible.mockImplementation((s) => Promise.resolve(s !== 'b'))
    await expect(
      f.registrations.enter(t.id, team.id, 'owner', { operationId: 'pay' }),
    ).rejects.toMatchObject({ code: 'INVALID_PLAYER' })
    expect(f.wallet.debits).toBe(0)
    f.accounts.eligible.mockResolvedValue(true)
    const entry = await f.registrations.enter(t.id, team.id, 'owner', { operationId: 'pay' })
    expect(entry.entryReceipt!.payment).toMatchObject({
      payerId: 'owner',
      method: 'CREDITS',
      amount: 100,
    })
    await f.registrations.enter(t.id, team.id, 'owner', { operationId: 'pay' })
    expect(f.wallet.debits).toBe(1)
    expect(await f.registrations.register(t.id, 'owner', input)).toEqual(entry)
    await expect(
      f.registrations.register(t.id, 'owner', { ...input, invitedMemberIds: ['a', 'other'] }),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
  })
  it('rechazo libera todas las identidades; duplicados de tercer miembro y tamaño inválido no pasan', async () => {
    const f = fixture(undefined, FREE_POLICY),
      t = await f.create('TRIO')
    const register = (operationId: string, owner: string, ids: string[]) =>
      f.registrations.register(t.id, owner, {
        operationId,
        name: 'Equipo',
        invitedMemberIds: ids,
        avatar: { kind: 'ACCOUNT_AVATAR', subject: owner },
      })
    for (const ids of [['owner', 'x'], ['x', 'x'], ['x'], ['x', 'y', 'z']])
      await expect(register('invalid', 'owner', ids)).rejects.toMatchObject({
        code: 'INVALID_PLAYER',
      })
    const team = await register('first', 'owner', ['x', 'y'])
    await expect(register('collision', 'other', ['z', 'y'])).rejects.toMatchObject({
      code: 'ALREADY_REGISTERED',
    })
    await f.registrations.consent(t.id, team.id, 'x', 'reject', false)
    expect((await register('again', 'other', ['z', 'y'])).status).toBe('AWAITING_CONSENT')
    await expect(
      f.registrations.register(t.id, 'compat', {
        operationId: 'old',
        name: 'Compat',
        companionId: 'mate',
        avatar: { kind: 'ACCOUNT_AVATAR', subject: 'compat' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ROSTER' })
  })
  it('no deduce modalidad de null/valor inválido; DTO antiguo conserva la huella y consentimiento original', async () => {
    const f = fixture(undefined, FREE_POLICY),
      t = await f.create()
    expect(t.tournamentMode).toBe('DUO')
    const old = await f.confirm(t.id)
    const snapshot = await f.repo.read(t.id)
    expect(await f.create()).toEqual(t)
    expect(await f.register(t.id)).toEqual(old)
    expect((await f.repo.read(t.id)).operations).toEqual(snapshot.operations)
    const bad = {
      name: t.name,
      opensAt: t.opensAt,
      closesAt: t.closesAt,
      startsAt: t.startsAt,
      operationId: 'bad',
      entryPolicy: FREE_POLICY,
      tournamentMode: 'INVALID' as TournamentMode,
    }
    await expect(f.registrations.create('admin', bad)).rejects.toMatchObject({
      code: 'INVALID_MODALITY',
    })
  })
  it('pago simulado conserva tarifa, recibo y recuperación para TRIO', async () => {
    const f = fixture(undefined, MIXED_POLICY),
      t = await f.create('TRIO')
    const team = await f.registrations.register(t.id, 'o', {
      operationId: 'r',
      name: 'Equipo',
      invitedMemberIds: ['a', 'b'],
      avatar: { kind: 'ACCOUNT_AVATAR', subject: 'o' },
    })
    for (const id of ['a', 'b']) await f.registrations.consent(t.id, team.id, id, 'c' + id, true)
    const input = { operationId: 'p', method: 'SIMULATED_MONEY' as const, card: CARD }
    const paid = await f.registrations.enter(t.id, team.id, 'o', input)
    expect(paid.entryReceipt!.payment).toMatchObject({
      method: 'SIMULATED_MONEY',
      amountMinor: 250050,
      realMoneyMoved: false,
    })
    expect(await f.registrations.enter(t.id, team.id, 'o', input)).toEqual(paid)
  })
})
