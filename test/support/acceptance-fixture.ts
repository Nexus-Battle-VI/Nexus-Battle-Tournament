import type { MatchAcceptanceStore } from '../../src/application/ports/MatchAcceptancePorts'
import type { LifecycleRepository } from '../../src/application/ports/LifecyclePorts'
import type { RegistrationRepository } from '../../src/application/ports/RegistrationPorts'
import type { TournamentEncounterRepositoryPort } from '../../src/application/ports/TournamentEncounterRepositoryPort'
import type { EncounterAdminStore } from '../../src/application/ports/EncounterAdminPorts'
import { modeFixture } from './modalities-fixture'
import { ControlledMatchRead } from './match-read-fixture'
import { InMemoryMatchAcceptanceStore } from '../../src/adapters/outbound/persistence/InMemoryMatchAcceptanceStore'
import { InMemoryLifecycleRepository } from '../../src/adapters/outbound/persistence/InMemoryLifecycleRepository'
import { InMemoryEncounterAdminStore } from '../../src/adapters/outbound/persistence/InMemoryEncounterAdminStore'
import { PersistedBracketEncounterSource } from '../../src/adapters/outbound/bracket/PersistedBracketEncounterSource'
import { Progressions } from '../../src/application/use-cases/Progressions'
import { MatchAcceptance } from '../../src/application/use-cases/MatchAcceptance'
import { EncounterAdministration } from '../../src/application/use-cases/EncounterAdministration'
import { AcceptanceReconciliation } from '../../src/application/use-cases/AcceptanceReconciliation'
import type { TournamentMode } from '../../src/domain/registration'
import type {
  CreateCombatRoomInput,
  StartCombatRoomInput,
} from '../../src/application/ports/CombatRoomCommandPort'
export const acceptanceFixture = async (
  options: {
    mode?: TournamentMode
    registrations?: RegistrationRepository
    encounters?: TournamentEncounterRepositoryPort
    acceptance?: MatchAcceptanceStore
    lifecycle?: LifecycleRepository
    actions?: EncounterAdminStore
  } = {},
) => {
  const f = await modeFixture(options.mode ?? 'TRIO', options.registrations),
    b = await f.publish()
  const store = options.acceptance ?? new InMemoryMatchAcceptanceStore(),
    lifecycle = options.lifecycle ?? new InMemoryLifecycleRepository()
  const source = new ControlledMatchRead(),
    encounters = options.encounters ?? f.encounters,
    actions = options.actions ?? new InMemoryEncounterAdminStore()
  const progress = new Progressions(lifecycle, f.repo, source, f.clock, encounters, store)
  const random = { bit: jest.fn<0 | 1, []>(() => 0) }
  const acceptance = new MatchAcceptance(store, f.repo, progress, f.clock, random)
  const commands = {
    createRoom: jest.fn((c: CreateCombatRoomInput) =>
      Promise.resolve({ roomId: 'room-' + c.encounterId }),
    ),
    startRoom: jest.fn<Promise<void>, [string, StartCombatRoomInput]>(() => Promise.resolve()),
  }
  const record = {
    readRecord: jest.fn(() =>
      Promise.reject(new Error('Doble sin registro: no inventa eventos de Combat')),
    ),
  }
  const admin = () =>
    new EncounterAdministration(
      encounters,
      new PersistedBracketEncounterSource(f.repo),
      record,
      commands,
      actions,
      f.clock,
      (id) => f.brackets.view(id),
      (id, encounterId) => acceptance.guard(id, encounterId),
    )
  const administration = admin(),
    worker = () => new AcceptanceReconciliation(f.repo, acceptance, admin(), progress)
  const reconciliation = new AcceptanceReconciliation(f.repo, acceptance, administration, progress)
  const e = (label = 'E1') => b.matches.find((m) => m.id === label)!
  const window = (round = 1) => f.t.roundSchedule.find((w) => w.round === round)!
  const setOpen = (round = 1) => {
    f.setNow(window(round).acceptanceOpensAt)
  }
  const setClose = async (round = 1) => {
    // Reloj controlado: representar los ticks de un worker sano durante la ventana.
    const active = []
    for (const m of b.matches.filter((m) => m.round === round)) {
      if ((await store.read(f.id, m.encounterId))?.phase === 'OPEN') active.push(m.encounterId)
    }
    const end = new Date(window(round).acceptanceClosesAt).getTime()
    for (let at = f.clock.now().getTime() + 5000; at < end; at += 5000) {
      f.setNow(new Date(at).toISOString())
      await Promise.all(active.map((e) => acceptance.decide(f.id, e)))
    }
    f.setNow(window(round).acceptanceClosesAt)
  }
  const acceptSide = async (label = 'E1', side = 0, count: number = f.t.teamSize) => {
    const state = await acceptance.decide(f.id, e(label).encounterId)
    const team = state.roster?.[side]
    if (team === undefined) throw new Error('Roster aún sin resolver')
    for (const subject of team.memberIds.slice(0, count))
      await acceptance.accept(
        f.id,
        e(label).encounterId,
        subject,
        'accept-' + e(label).encounterId + '-' + subject,
      )
  }
  return {
    ...f,
    b,
    store,
    lifecycle,
    source,
    encounters,
    actions,
    progress,
    random,
    acceptance,
    commands,
    record,
    administration,
    reconciliation,
    worker,
    e,
    window,
    setOpen,
    setClose,
    acceptSide,
  }
}
