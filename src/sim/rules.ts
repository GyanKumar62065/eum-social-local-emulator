import type { RequestErrorMode, SimRule, StatusName } from '../config.ts'
import { metaError, type MetaError } from '../domain/metaErrors.ts'
import { denied, dependencyFailure, internalFailure, throttled } from '../smithy/errors.ts'
import type { AwsError } from '../smithy/errors.ts'
export interface Outcome { flow: StatusName[]; failure?: MetaError; requestError?: AwsError }
export function globMatch(pattern: string, value: string): boolean {
  const escaped = [...pattern].map((char) => char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('')
  return new RegExp(`^${escaped}$`).test(value)
}
export function decideOutcome(rules: SimRule[], defaultFlow: StatusName[], msg: { to: string; type: string; template?: string }): Outcome {
  for (const { match, outcome } of rules) {
    if (match.to && !globMatch(match.to, msg.to)) continue
    if (match.type && match.type !== msg.type) continue
    if (match.template && match.template !== msg.template) continue
    if (outcome.requestError) return { flow: [], requestError: requestError(outcome.requestError, outcome.title) }
    if (outcome.status === 'failed') return { flow: ['failed'], failure: metaError(outcome.code ?? 131026, outcome.title) }
    const flow = outcome.flow ?? defaultFlow
    return { flow, failure: flow.includes('failed') ? metaError(outcome.code ?? 131026, outcome.title) : undefined }
  }
  return { flow: defaultFlow }
}
function requestError(mode: RequestErrorMode, title?: string): AwsError {
  if (mode === 'denied') return denied(title)
  if (mode === 'throttled') return throttled(title)
  if (mode === 'dependency') return dependencyFailure(title)
  return internalFailure(title)
}
