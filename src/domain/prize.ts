import type { Champion } from './progression'
import { RegistrationError, requireRule } from './registration'

export interface PrizeAllocation {
  memberIndex: 0 | 1 | 2
  credits: string
  epicProductId: string | null
}
export interface PrizeConfiguration {
  operationId: string
  allocations: PrizeAllocation[]
  approvedBy: string
  approvedAt: string
}
export interface PrizeGrant {
  operationId: string
  tournamentId: string
  championTeamId: string
  finalEncounterId: string
  finalRoomId: string | null
  playerId: string
  heroId: string | null
  kind: 'CREDITS' | 'EPIC'
  amount: string | null
  productId: string | null
}
export interface PrizeLine extends PrizeGrant {
  finalResolutionId?: string
  responsible?: 'PRIZE_OPERATIONS' | null
  status: 'PENDING' | 'DELIVERED'
  receiptId: string | null
  deliveredAt: string | null
  lastError: string | null
}
export interface PrizeDelivery {
  requestedAt: string
  requestedBy: string
  lines: PrizeLine[]
}
export const validatePrizeConfiguration = (
  raw: unknown,
  teamSize = 2,
): Pick<PrizeConfiguration, 'operationId' | 'allocations'> => {
  const fail = (): never => {
    throw new RegistrationError(
      'INVALID_PRIZE_CONFIGURATION',
      `Define ${String(teamSize)} integrante(s), créditos enteros positivos y al menos una épica explícita.`,
      400,
    )
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail()
  const c = raw as Record<string, unknown>
  if (
    Object.keys(c).some((k) => !['operationId', 'allocations'].includes(k)) ||
    typeof c.operationId !== 'string' ||
    !c.operationId.trim() ||
    c.operationId.length > 160 ||
    !Array.isArray(c.allocations) ||
    c.allocations.length !== teamSize
  )
    return fail()
  const allocations: PrizeAllocation[] = []
  for (const item of c.allocations) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return fail()
    const a = item as Record<string, unknown>
    if (
      Object.keys(a).some((k) => !['memberIndex', 'credits', 'epicProductId'].includes(k)) ||
      (a.memberIndex !== 0 && a.memberIndex !== 1 && a.memberIndex !== 2) ||
      a.memberIndex >= teamSize ||
      typeof a.credits !== 'string' ||
      !/^[1-9]\d{0,15}$/.test(a.credits) ||
      BigInt(a.credits) > BigInt(Number.MAX_SAFE_INTEGER) ||
      !(
        a.epicProductId === null ||
        (typeof a.epicProductId === 'string' &&
          a.epicProductId.trim().length > 0 &&
          a.epicProductId.length <= 160)
      )
    )
      return fail()
    allocations.push({
      memberIndex: a.memberIndex,
      credits: a.credits,
      epicProductId: a.epicProductId,
    })
  }
  if (
    new Set(allocations.map((a) => a.memberIndex)).size !== teamSize ||
    !allocations.some((a) => a.epicProductId !== null) ||
    allocations.reduce((total, a) => total + BigInt(a.credits), 0n) >
      BigInt(Number.MAX_SAFE_INTEGER)
  )
    return fail()
  return {
    operationId: c.operationId,
    allocations: allocations.sort((a, b) => a.memberIndex - b.memberIndex),
  }
}
export const createPrizeDelivery = (
  tournamentId: string,
  champion: Champion,
  configuration: PrizeConfiguration,
  actor: string,
  at: string,
): PrizeDelivery => {
  const lines: PrizeLine[] = []
  for (const a of configuration.allocations) {
    const playerId = champion.memberIds[a.memberIndex]
    requireRule(
      playerId !== undefined,
      'INVALID_PRIZE_RECIPIENT',
      'El reparto no corresponde al roster del campeón.',
      409,
    )
    const hero = champion.heroes.find((h) => h.playerId === playerId)
    for (const kind of ['CREDITS', 'EPIC'] as const) {
      if (kind === 'EPIC' && a.epicProductId === null) continue
      lines.push({
        operationId: `tournament:${tournamentId}:prize:${String(a.memberIndex)}:${kind}`,
        tournamentId,
        championTeamId: champion.teamId,
        finalEncounterId: champion.finalEncounterId,
        finalRoomId: champion.finalRoomId,
        ...(champion.finalResolutionId === undefined
          ? {}
          : { finalResolutionId: champion.finalResolutionId }),
        playerId,
        heroId: hero?.heroId ?? null,
        kind,
        amount: kind === 'CREDITS' ? a.credits : null,
        productId: kind === 'EPIC' ? a.epicProductId : null,
        status: 'PENDING',
        receiptId: null,
        deliveredAt: null,
        lastError: hero === undefined ? 'PRIZE_RECIPIENT_REQUIRED' : null,
        responsible: hero === undefined ? 'PRIZE_OPERATIONS' : null,
      })
    }
  }
  return { requestedAt: at, requestedBy: actor, lines }
}
export const grantCommand = (line: PrizeLine): PrizeGrant => {
  requireRule(
    line.heroId !== null,
    'PRIZE_RECIPIENT_REQUIRED',
    'Falta un héroe receptor autoritativo; el derecho sigue pendiente.',
    409,
  )
  return {
    operationId: line.operationId,
    tournamentId: line.tournamentId,
    championTeamId: line.championTeamId,
    finalEncounterId: line.finalEncounterId,
    finalRoomId: line.finalRoomId,
    playerId: line.playerId,
    heroId: line.heroId,
    kind: line.kind,
    amount: line.amount,
    productId: line.productId,
  }
}
export const validatePrizeReceipt = (command: PrizeGrant, raw: unknown): string => {
  const r = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  requireRule(
    Object.entries(command).every(([k, v]) => r[k] === v) &&
      r.status === 'DELIVERED' &&
      typeof r.receiptId === 'string' &&
      r.receiptId.trim().length > 0,
    'PRIZE_RECEIPT_INVALID',
    'El destino devolvió un recibo incompatible; se conserva el derecho pendiente.',
    503,
  )
  return r.receiptId
}
export const deliveryStatus = (d: PrizeDelivery): 'PENDING' | 'PARTIAL' | 'COMPLETED' =>
  d.lines.every((l) => l.status === 'DELIVERED')
    ? 'COMPLETED'
    : d.lines.some((l) => l.status === 'DELIVERED')
      ? 'PARTIAL'
      : 'PENDING'
