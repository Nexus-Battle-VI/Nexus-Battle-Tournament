import { Broadcasts } from '../../src/application/use-cases/Broadcasts'
import { InMemoryBroadcastRepository } from '../../src/adapters/outbound/persistence/InMemoryBroadcastRepository'
import { ControlledMatchRead, publishedFixture, matchFixture } from './match-read-fixture'
export const broadcastFixture = async () => {
  const f = await publishedFixture(),
    source = new ControlledMatchRead(),
    repository = new InMemoryBroadcastRepository()
  const e1 = matchFixture(f.tournament.bracket!, 'E1', [], null, false, 1),
    e2 = matchFixture(f.tournament.bracket!, 'E2', [], null, false, 1)
  source.items.set(e1.encounterId, e1)
  source.items.set(e2.encounterId, e2)
  const service = new Broadcasts(repository, f.repo, source, f.clock)
  return { ...f, source, repository, service, e1, e2 }
}
