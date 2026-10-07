import { randomInt } from 'node:crypto'
import type { FairRandomPort } from '../../../application/ports/MatchAcceptancePorts'
/** randomInt usa muestreo sin sesgo; solo la decisión ganadora persiste su bit. */
export class CryptoFairRandom implements FairRandomPort {
  bit(): 0 | 1 {
    return randomInt(2) === 0 ? 0 : 1
  }
}
