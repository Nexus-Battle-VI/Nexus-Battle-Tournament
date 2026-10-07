import { generateBracket, type PublishedBracket } from '../../domain/bracket'
import {
  getOperation,
  saveOperation,
  validateOperation,
  requireRule,
} from '../../domain/registration'
import type { ClockPort } from '../ports/ClockPort'
import type { RegistrationRepository } from '../ports/RegistrationPorts'
export const BRACKETS = Symbol('Brackets')
export class Brackets {
  constructor(
    private readonly repository: RegistrationRepository,
    private readonly clock: ClockPort,
  ) {}
  async view(id: string): Promise<PublishedBracket | null> {
    return (await this.repository.read(id)).bracket
  }
  publish(id: string, subject: string, operationId: string): Promise<PublishedBracket> {
    validateOperation(operationId)
    return this.repository.change(id, (t) => {
      const intent = JSON.stringify(['bracket', subject])
      const previous = getOperation(t, operationId)
      requireRule(
        previous === undefined || previous.intent === intent,
        'OPERATION_CONFLICT',
        'El identificador corresponde a otra intención.',
        409,
      )
      t.bracket ??= generateBracket(t, operationId, subject, this.clock.now())
      saveOperation(t, operationId, { intent, teamId: '' })
      return structuredClone(t.bracket)
    })
  }
}
