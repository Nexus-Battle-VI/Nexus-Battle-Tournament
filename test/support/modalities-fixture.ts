import { fixture, FREE_POLICY } from './registration-fixture'
import type { RegistrationRepository } from '../../src/application/ports/RegistrationPorts'
import type { TournamentMode, EntryPolicy } from '../../src/domain/registration'
export const modeFixture = async (
  mode: TournamentMode = 'TRIO',
  repo?: RegistrationRepository,
  policy: EntryPolicy = FREE_POLICY,
) => {
  const f = fixture(repo, policy),
    t = await f.create(mode)
  const register = async (n: number) => {
    const owner = `p${String(n)}_0`
    const invitedMemberIds = Array.from(
      { length: t.teamSize - 1 },
      (_, i) => `p${String(n)}_${String(i + 1)}`,
    )
    const team = await f.registrations.register(t.id, owner, {
      operationId: `r${String(n)}`,
      name: `Equipo ${String(n)}`,
      invitedMemberIds,
      avatar: { kind: 'ACCOUNT_AVATAR', subject: owner },
    })
    for (const player of invitedMemberIds)
      await f.registrations.consent(t.id, team.id, player, 'c' + player, true)
    return team
  }
  const confirm = async (n: number) => {
    const team = await register(n)
    return f.registrations.enter(t.id, team.id, team.ownerId, { operationId: `p${String(n)}` })
  }
  const publish = async () => {
    for (let n = 0; n < 8; n++) await confirm(n)
    const bracket = await f.brackets.publish(t.id, 'admin', 'publish')
    return bracket
  }
  return { ...f, t, id: t.id, modeRegister: register, modeConfirm: confirm, publish }
}
