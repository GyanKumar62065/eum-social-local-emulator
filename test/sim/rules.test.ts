import { describe, expect, it } from 'vitest'
import { decideOutcome, globMatch } from '../../src/sim/rules.ts'
import { WINDOW_MS, windowOpen } from '../../src/sim/window.ts'
describe('outcome rules', () => {
  it('matches globs literally apart from * and ?', () => { expect(globMatch('*0000', '+919800000000')).toBe(true); expect(globMatch('+91*', '+15550000')).toBe(false); expect(globMatch('+1555000?', '+15550001')).toBe(true); expect(globMatch('+1.5', '+125')).toBe(false) })
  it('takes the first matching rule, else the default flow', () => {
    const rules = [{ match: { to: '*0000' }, outcome: { status: 'failed' as const, code: 131026 } }, { match: { to: '*1111', type: 'template' }, outcome: { flow: ['sent' as const, 'delivered' as const] } }, { match: { template: 'promo' }, outcome: { status: 'failed' as const, code: 131050 } }]
    const dflt = ['sent', 'delivered', 'read'] as const
    expect(decideOutcome(rules, [...dflt], { to: '+10000', type: 'text' })).toEqual({ flow: ['failed'], failure: { code: 131026, title: 'Message undeliverable' } })
    expect(decideOutcome(rules, [...dflt], { to: '+11111', type: 'template' })).toEqual({ flow: ['sent', 'delivered'], failure: undefined })
    expect(decideOutcome(rules, [...dflt], { to: '+11111', type: 'text' })).toEqual({ flow: ['sent', 'delivered', 'read'] })
    expect(decideOutcome(rules, [...dflt], { to: '+12', type: 'template', template: 'promo' }).failure?.code).toBe(131050)
  })
  it('treats a 24h window as open only after a recent inbound', () => { expect(windowOpen(undefined, 1000)).toBe(false); expect(windowOpen(0, WINDOW_MS - 1)).toBe(true); expect(windowOpen(0, WINDOW_MS)).toBe(false) })
})
