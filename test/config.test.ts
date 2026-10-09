import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config.ts'

describe('parseConfig', () => {
  it('applies defaults when there is no file', () => {
    const c = parseConfig(undefined, {})
    expect(c).toMatchObject({ port: 4580, host: '127.0.0.1', dbPath: './data/eum-local.db', region: 'ap-south-1', accountId: '000000000000', wabas: [], templates: { autoApproveSeconds: 0 }, messageIdMode: 'uuid', sim: { defaultFlow: ['sent', 'delivered', 'read'], stepDelayMs: 1000, rules: [] } })
    expect(c.aws).toBeUndefined()
  })

  it('lets environment variables override the file', () => {
    const c = parseConfig('port: 1\naws:\n  endpoint: http://a:1\n', { EUM_PORT: '9', EUM_DB: ':memory:', EUM_AWS_ENDPOINT: 'http://b:2' })
    expect(c.port).toBe(9)
    expect(c.dbPath).toBe(':memory:')
    expect(c.aws).toEqual({ endpoint: 'http://b:2' })
  })

  it('keeps unquoted numeric Meta ids as strings', () => {
    const c = parseConfig('wabas:\n  - name: A\n    metaWabaId: 100000000000001\n    phoneNumbers:\n      - phoneNumber: "+919800000001"\n        displayName: A\n        metaPhoneNumberId: 200000000000001\n', {})
    expect(c.wabas[0].metaWabaId).toBe('100000000000001')
    expect(c.wabas[0].phoneNumbers![0].metaPhoneNumberId).toBe('200000000000001')
  })

  it('keeps numeric simulation error codes as numbers', () => {
    const c = parseConfig('sim:\n  rules:\n    - match: { to: "*0000" }\n      outcome: { status: failed, code: 131026 }\n', {})
    expect(c.sim.rules[0].outcome.code).toBe(131026)
    expect(typeof c.sim.rules[0].outcome.code).toBe('number')
  })

  it('rejects bad config with the source and reason', () => {
    expect(() => parseConfig('wabas:\n  - name: A\n', {}, 'x.yaml')).toThrow(/x\.yaml: wabas\[0\]\.metaWabaId/)
    expect(() => parseConfig('sim:\n  defaultFlow: [sent, bogus]\n', {})).toThrow(/sim\.defaultFlow/)
    expect(() => parseConfig('messageIdMode: nope\n', {})).toThrow(/messageIdMode/)
    expect(() => parseConfig('wabas:\n  - name: A\n    metaWabaId: "1"\n    phoneNumbers:\n      - phoneNumber: "98000"\n        displayName: A\n        metaPhoneNumberId: "2"\n', {})).toThrow(/E\.164/)
  })
})
