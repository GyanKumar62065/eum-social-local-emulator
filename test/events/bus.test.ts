import { describe, expect, it } from 'vitest'
import { parseConfig } from '../../src/config.ts'
import { EventBus, type BusEvent, type Sink } from '../../src/events/bus.ts'
import { openDb } from '../../src/store/db.ts'
import { listEvents } from '../../src/store/events.ts'
import { createWaba } from '../../src/store/seed.ts'

const config = parseConfig(undefined, {})
const quietLog = { error: () => {} }
function setup(sinks: Sink[], destinations: string[]) {
  const db = openDb(':memory:')
  const waba = createWaba(db, config, { name: 'W', metaWabaId: '1', eventDestinations: destinations }, 0)
  const bus = new EventBus({ db, sinks, accountId: '000000000000', log: quietLog })
  return { db, waba, bus }
}
describe('EventBus', () => {
  it('stores the event, publishes to matching sinks and notifies subscribers', async () => {
    const published: string[] = []
    const sink: Sink = { name: 'cap', accepts: (arn) => arn.startsWith('arn:aws:sns:'), publish: async (arn) => { published.push(arn); return 'msg-1' } }
    const { db, waba, bus } = setup([sink], ['arn:aws:sns:ap-south-1:000000000000:t', 'arn:aws:connect:ap-south-1:000000000000:instance/x'])
    const seen: BusEvent[] = []; bus.subscribe((event) => seen.push(event))
    const row = await bus.emit({ kind: 'status', waba, now: 5, change: { field: 'messages', value: {} } })
    expect(published).toEqual(['arn:aws:sns:ap-south-1:000000000000:t'])
    expect(row.deliveries).toEqual([{ destination: 'arn:aws:sns:ap-south-1:000000000000:t', ok: true, detail: 'msg-1' }, { destination: 'arn:aws:connect:ap-south-1:000000000000:instance/x', ok: false, detail: 'skipped: unsupported destination' }])
    expect(listEvents(db, {})[0].deliveries).toEqual(row.deliveries)
    expect(seen.map((event) => event.type)).toEqual(['event'])
  })
  it('records a failing sink without throwing (Review Focus 3)', async () => {
    const sink: Sink = { name: 'down', accepts: () => true, publish: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:4566') } }
    const { bus, waba } = setup([sink], ['arn:aws:sns:ap-south-1:000000000000:t'])
    const row = await bus.emit({ kind: 'status', waba, now: 0, change: { field: 'messages', value: {} } })
    expect(row.deliveries[0]).toEqual({ destination: 'arn:aws:sns:ap-south-1:000000000000:t', ok: false, detail: 'connect ECONNREFUSED 127.0.0.1:4566' })
  })
  it('unsubscribes', () => { const { bus } = setup([], []); let count = 0; const off = bus.subscribe(() => count++); bus.notify({ type: 'waba' }); off(); bus.notify({ type: 'waba' }); expect(count).toBe(1) })
})
