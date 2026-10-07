import { InMemoryTournamentEncounterRepository } from '../../src/adapters/outbound/persistence/InMemoryTournamentEncounterRepository'
import { InMemoryRegistrationRepository } from '../../src/adapters/outbound/persistence/InMemoryRegistrationRepository'
import { InMemoryExternalLinksRepository } from '../../src/adapters/outbound/persistence/InMemoryExternalLinksRepository'
import { ExternalLinks } from '../../src/application/use-cases/ExternalLinks'
import { bracketClock, tournamentFixture } from '../support/bracket-fixture'

const channel = 'https://www.youtube.com/channel/UCscW71t4iP--b-7HFDPFosA'
const live = 'https://www.youtube.com/watch?v=abcdefghijk'
describe('HU-82 — enlaces por torneo', () => {
  const setup = async () => {
    const tournaments = new InMemoryRegistrationRepository(
      new InMemoryTournamentEncounterRepository(),
    )
    await tournaments.create(tournamentFixture(), 'create-T1', 'T1')
    await tournaments.create(tournamentFixture('T2', '2027-02-01T00:00:00Z'), 'create-T2', 'T2')
    const repository = new InMemoryExternalLinksRepository()
    return { repository, service: new ExternalLinks(repository, tournaments, bracketClock) }
  }
  it('empieza sin enlaces, publica una pareja y separa torneos', async () => {
    const { service } = await setup()
    expect(await service.view('T1')).toEqual({
      tournamentId: 'T1',
      liveUrl: null,
      youtubeArchiveUrl: null,
      revision: 0,
      updatedAt: null,
    })
    expect(
      await service.save('T1', { liveUrl: live, youtubeArchiveUrl: channel, expectedRevision: 0 }),
    ).toMatchObject({ liveUrl: live, youtubeArchiveUrl: channel, revision: 1 })
    expect((await service.view('T2')).liveUrl).toBeNull()
    await expect(service.view('unknown')).rejects.toMatchObject({ status: 404 })
  })
  it('rechaza todo el cambio si cualquier destino es inválido y conserva la pareja válida', async () => {
    const { service } = await setup()
    const saved = await service.save('T1', {
      liveUrl: live,
      youtubeArchiveUrl: channel,
      expectedRevision: 0,
    })
    for (const bad of [
      'no es una URL',
      'javascript:alert(1)',
      'http://www.youtube.com/watch?v=abcdefghijk',
      'https://youtube.com.evil.test/watch?v=abcdefghijk',
      'https://studio.youtube.com/',
      'https://www.youtube.com/',
      'https://www.youtube.com/redirect?q=https://evil.test',
      'https://user:secret@www.youtube.com/watch?v=abcdefghijk',
      'https://www.youtube.com:444/watch?v=abcdefghijk',
      'https://www.youtube.com/watch?v=abcdefghijk&key=secret',
      'https://www.youtube.com/watch?v=abcdefghijk#token',
      'https://www.youtube.com/watch?v=abc\ndefghijk',
      'https://www.youtube.com\\@evil.test/live',
    ]) {
      await expect(
        service.save('T1', { liveUrl: bad, youtubeArchiveUrl: channel, expectedRevision: 1 }),
      ).rejects.toMatchObject({ code: 'LINKS_INVALID', status: 422 })
      expect(await service.view('T1')).toEqual(saved)
    }
    for (const bad of ['https://www.twitch.tv/nexus', live, 'https://youtu.be/abcdefghijk']) {
      await expect(
        service.save('T1', {
          liveUrl: 'https://www.twitch.tv/nexus',
          youtubeArchiveUrl: bad,
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ code: 'LINKS_INVALID' })
      expect(await service.view('T1')).toEqual(saved)
    }
  })
  it('acepta destinos públicos definidos, normaliza y permite corregir después de emitir', async () => {
    const { service } = await setup()
    let revision = 0
    for (const url of [
      live,
      'https://youtu.be/abcdefghijk',
      'https://www.youtube.com/live/abcdefghijk',
      `${channel}/live`,
      'https://www.youtube.com/@NexusBattlesVI/live',
      'https://www.twitch.tv/nexus',
    ]) {
      const saved = await service.save('T1', {
        liveUrl: url,
        youtubeArchiveUrl: ` ${channel}/streams `,
        expectedRevision: revision,
      })
      expect(saved.youtubeArchiveUrl).toBe(`${channel}/streams`)
      revision = saved.revision
    }
    expect(
      await service.save('T1', {
        liveUrl: null,
        youtubeArchiveUrl: channel,
        expectedRevision: revision,
      }),
    ).toMatchObject({ liveUrl: null, youtubeArchiveUrl: channel })
  })
  it('reintento tras respuesta perdida es idempotente y una corrección obsoleta se rechaza', async () => {
    const { service } = await setup()
    const command = { liveUrl: live, youtubeArchiveUrl: channel, expectedRevision: 0 }
    const saved = await service.save('T1', command)
    expect(await service.save('T1', command)).toEqual(saved)
    await expect(
      service.save('T1', { ...command, liveUrl: 'https://www.twitch.tv/nexus' }),
    ).rejects.toMatchObject({ code: 'LINKS_CHANGED', status: 409 })
    expect(await service.view('T1')).toEqual(saved)
  })
  it('no crea cambios vacíos y valida cuerpos de los adaptadores', async () => {
    const { service } = await setup()
    expect(
      (await service.save('T1', { liveUrl: null, youtubeArchiveUrl: null, expectedRevision: 0 }))
        .revision,
    ).toBe(0)
    for (const cmd of [
      { liveUrl: '', youtubeArchiveUrl: null, expectedRevision: 0 },
      { liveUrl: live, youtubeArchiveUrl: channel, expectedRevision: -1 },
      { liveUrl: live, youtubeArchiveUrl: channel, expectedRevision: 0.5 },
      { liveUrl: 123, youtubeArchiveUrl: channel, expectedRevision: 0 },
      {
        liveUrl: `https://youtu.be/${'x'.repeat(2050)}`,
        youtubeArchiveUrl: null,
        expectedRevision: 0,
      },
    ])
      await expect(service.save('T1', cmd as never)).rejects.toMatchObject({
        code: 'LINKS_INVALID',
      })
  })
})
