import type { SimRule, StatusName } from '../config.ts'
import { metaError, type MetaError } from '../domain/metaErrors.ts'
export interface Outcome { flow: StatusName[]; failure?: MetaError }
export function globMatch(pattern: string, value: string): boolean {
  const escaped = [...pattern].map((char) => char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('')
  return new RegExp(`^${escaped}$`).test(value)
}
export function decideOutcome(rules: SimRule[], defaultFlow: StatusName[], msg: { to: string; type: string; template?: string }): Outcome {
  for (const { match, outcome } of rules) {
    if (match.to && !globMatch(match.to, msg.to)) continue
    if (match.type && match.type !== msg.type) continue
    if (match.template && match.template !== msg.template) continue
    if (outcome.status === 'failed') return { flow: ['failed'], failure: metaError(outcome.code ?? 131026, outcome.title) }
    const flow = outcome.flow ?? defaultFlow
    return { flow, failure: flow.includes('failed') ? metaError(outcome.code ?? 131026, outcome.title) : undefined }
  }
  return { flow: defaultFlow }
}
