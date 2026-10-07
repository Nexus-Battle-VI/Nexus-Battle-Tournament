import { RegistrationError, requireRule } from './registration'

export interface ExternalLinksState {
  tournamentId: string
  liveUrl: string | null
  youtubeArchiveUrl: string | null
  revision: number
  updatedAt: string | null
}
export const emptyExternalLinks = (tournamentId: string): ExternalLinksState => ({
  tournamentId,
  liveUrl: null,
  youtubeArchiveUrl: null,
  revision: 0,
  updatedAt: null,
})
const youtubeHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com'])
const twitchHosts = new Set(['twitch.tv', 'www.twitch.tv'])
const channelPath = /^\/(?:channel\/[A-Za-z0-9_-]+|@[A-Za-z0-9_.-]+|(?:c|user)\/[A-Za-z0-9_.-]+)$/u
const videoPath = /^\/live\/[A-Za-z0-9_-]{11}$/u
const videoId = /^[A-Za-z0-9_-]{11}$/u
const playbackTime = /^\d+(?:[hms]\d+)*[hms]?$/u
const reservedTwitch = new Set([
  'directory',
  'settings',
  'login',
  'signup',
  'downloads',
  'search',
  'subscriptions',
  'inventory',
])
export const normalizeExternalUrl = (raw: unknown, archive: boolean): string | null => {
  const label = archive ? 'canal de grabaciones' : 'directo'
  const reject = (condition: boolean, reason: string): void => {
    requireRule(condition, 'LINKS_INVALID', `Enlace del ${label}: ${reason}`, 422)
  }
  if (raw === null) return null
  if (typeof raw !== 'string')
    throw new RegistrationError(
      'LINKS_INVALID',
      `Enlace del ${label}: debe ser una dirección HTTPS o null.`,
      422,
    )
  const input = raw.trim()
  reject(
    input.length > 0 && input.length <= 2048 && !/[\s\\#\p{Cc}]/u.test(input),
    'dirección vacía, demasiado larga o con caracteres no permitidos.',
  )
  let url: URL
  try {
    url = new URL(input)
  } catch {
    reject(false, 'debe ser una dirección web absoluta.')
    return null
  }
  reject(
    url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.port === '' &&
      !/^https:\/\/[^/]*:\d+/iu.test(input),
    'usa HTTPS sin credenciales ni puertos personalizados.',
  )
  const path = url.pathname.replace(/\/$/u, '')
  const channel = channelPath.test(path)
  const archivePath = channelPath.test(path.replace(/\/(?:videos|streams|live)$/u, ''))
  if (archive) {
    reject(
      youtubeHosts.has(url.hostname) && archivePath && url.search === '',
      'usa el canal oficial de YouTube o su pestaña de vídeos/emisiones.',
    )
    url.search = ''
  } else if (youtubeHosts.has(url.hostname) || url.hostname === 'youtu.be') {
    const watch = youtubeHosts.has(url.hostname) && path === '/watch'
    const video =
      watch || (url.hostname === 'youtu.be' ? videoId.test(path.slice(1)) : videoPath.test(path))
    reject(
      video ||
        (youtubeHosts.has(url.hostname) &&
          (channel || channelPath.test(path.replace(/\/live$/u, '')))),
      'usa un vídeo, directo o canal de YouTube.',
    )
    const entries = [...url.searchParams]
    reject(
      entries.every(([key]) => (watch && key === 'v') || (video && key === 't')) &&
        new Set(entries.map(([key]) => key)).size === entries.length,
      'solo se permiten parámetros públicos de vídeo y tiempo.',
    )
    const v = url.searchParams.get('v'),
      t = url.searchParams.get('t')
    reject(!watch || (v !== null && videoId.test(v)), 'falta un identificador válido de vídeo.')
    reject(t === null || playbackTime.test(t), 'tiempo de reproducción inválido.')
    url.search = ''
    if (watch && v !== null) url.searchParams.set('v', v)
    if (t !== null) url.searchParams.set('t', t)
  } else {
    reject(
      twitchHosts.has(url.hostname) &&
        (/^\/[A-Za-z0-9_]{1,25}$/u.test(path) || /^\/videos\/\d+$/u.test(path)) &&
        !reservedTwitch.has(path.slice(1).toLowerCase()) &&
        url.search === '',
      'el destino permitido es YouTube o un canal/vídeo público de Twitch.',
    )
    url.search = ''
  }
  return url.href
}
