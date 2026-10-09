import { describe, expect, it } from 'vitest'
import { parseConfig, type Config } from '../../src/config.ts'
import { phoneAwsId, wabaAwsId } from '../../src/domain/ids.ts'
import { EventBus } from '../../src/events/bus.ts'
import { FakeClock } from '../../src/sim/clock.ts'
import { Simulator } from '../../src/sim/simulator.ts'
import { openDb } from '../../src/store/db.ts'
import { listEvents } from '../../src/store/events.ts'
import { getMessage, insertMessage } from '../../src/store/messages.ts'
import { seedFromConfig } from '../../src/store/seed.ts'
import { findTemplate, getTemplateById } from '../../src/store/templates.ts'
import type { MessageRow } from '../../src/store/types.ts'
const YAML = `\nwabas:\n  - name: W\n    metaWabaId: "1"\n    eventDestinations: [arn:aws:sns:ap-south-1:000000000000:t]\n    phoneNumbers: [{ phoneNumber: "+919800000001", displayName: P, metaPhoneNumberId: "2" }]\n    templates:\n      - { name: hello, language: en, category: UTILITY, components: [{ type: BODY, text: "Hi {{1}}" }] }\nsim:\n  stepDelayMs: 1000\n  rules:\n    - { match: { to: "*0000" }, outcome: { status: failed, code: 131026 } }\n`
const PHONE = phoneAwsId('2')
function setup(over: Partial<Config> = {}) {
  const config = { ...parseConfig(YAML, {}), ...over }; const db = openDb(':memory:'); seedFromConfig(db, config, 0)
  const clock = new FakeClock(); const bus = new EventBus({ db, sinks: [], accountId: '000000000000', log: { error: () => {} } }); const sim = new Simulator({ db, clock, bus, config })
  return { db, clock, sim, config }
}
function out(db: ReturnType<typeof openDb>, clock: FakeClock, body: any, peer = '+15550001'): MessageRow {
  const msg: MessageRow = { wamid: `wamid.${Math.random().toString(36).slice(2)}`, phoneNumberId: PHONE, direction: 'out', peer, type: body.type, body, status: 'accepted', createdAt: clock.now() }; insertMessage(db, msg); return msg
}
const templateBody = (params: string[]) => ({ type: 'template', template: { name: 'hello', language: { code: 'en' }, components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] } })
describe('Simulator', () => {
  it('walks the default flow one step per stepDelayMs', async () => {
    const { db, clock, sim } = setup(); const msg = out(db, clock, templateBody(['Asha'])); sim.onSend(msg, findTemplate(db, wabaAwsId('1'), 'hello', 'en'))
    await clock.advance(1000); expect(getMessage(db, msg.wamid)?.status).toBe('sent'); await clock.advance(2000); expect(getMessage(db, msg.wamid)?.status).toBe('read')
    expect(listEvents(db, { kind: 'status' }).map((event) => JSON.parse(event.envelope.whatsAppWebhookEntry).changes[0].value.statuses[0].status)).toEqual(['read', 'delivered', 'sent'])
  })
  it('fails templates Meta would reject, before any rule', () => { const { db, clock, sim } = setup(); const template = findTemplate(db, wabaAwsId('1'), 'hello', 'en'); expect(sim.decide(out(db, clock, templateBody([])), template)).toMatchObject({ flow: ['failed'], failure: { code: 132000 } }); expect(sim.decide(out(db, clock, templateBody(['a'])), undefined)).toMatchObject({ failure: { code: 132001 } }) })
  it('fails free-form text outside the 24h window and allows it after an inbound', async () => { const { db, clock, sim } = setup(); expect(sim.decide(out(db, clock, { type: 'text', text: { body: 'hi' } }), undefined)).toMatchObject({ failure: { code: 131047 } }); await sim.inbound({ phoneNumberId: PHONE, from: '+15550001', type: 'text', text: 'hello' }); expect(sim.decide(out(db, clock, { type: 'text', text: { body: 'hi' } }), undefined)).toEqual({ flow: ['sent', 'delivered', 'read'] }) })
  it('applies configured rules', () => { const { db, clock, sim } = setup(); expect(sim.decide(out(db, clock, templateBody(['a']), '+919800000000'), findTemplate(db, wabaAwsId('1'), 'hello', 'en'))).toMatchObject({ failure: { code: 131026 } }) })
  it('records an inbound message and emits a messages event with contacts', async () => { const { db, sim } = setup(); const msg = await sim.inbound({ phoneNumberId: PHONE, from: '15550001', name: 'Asha', type: 'text', text: 'STOP' }); expect(msg).toMatchObject({ direction: 'in', peer: '+15550001', renderedText: 'STOP', status: 'received' }); const value = JSON.parse(listEvents(db, { kind: 'inbound' })[0].envelope.whatsAppWebhookEntry).changes[0].value; expect(value.messages[0]).toMatchObject({ from: '15550001', type: 'text', text: { body: 'STOP' } }) })
  it('stores inbound images as media', async () => { const { sim } = setup(); const msg = await sim.inbound({ phoneNumberId: PHONE, from: '+15550001', type: 'image', mediaBase64: Buffer.from('png').toString('base64'), mimeType: 'image/png' }); expect(msg.body.image).toMatchObject({ mime_type: 'image/png', id: expect.stringMatching(/^\d+$/) }) })
  it('ignores statuses for messages that no longer exist (Review Focus 2)', async () => { const { sim } = setup(); await expect(sim.applyStatus('wamid.gone', 'sent')).resolves.toBeUndefined() })
  it('auto-approves PENDING templates and emits template status events', async () => {
    const { db, clock, sim } = setup({ templates: { autoApproveSeconds: 5 } }); const template = findTemplate(db, wabaAwsId('1'), 'hello', 'en')!; db.prepare("UPDATE template SET status = 'PENDING' WHERE meta_template_id = ?").run(template.metaTemplateId); sim.scheduleTemplateApproval({ ...template, status: 'PENDING' })
    await clock.advance(4999); expect(getTemplateById(db, template.metaTemplateId)?.status).toBe('PENDING'); await clock.advance(1); expect(getTemplateById(db, template.metaTemplateId)?.status).toBe('APPROVED')
    expect(JSON.parse(listEvents(db, { kind: 'template_status' })[0].envelope.whatsAppWebhookEntry).changes[0]).toMatchObject({ field: 'message_template_status_update', value: { event: 'APPROVED' } })
  })
  it('never auto-approves when autoApproveSeconds is -1', () => { const { db, clock, sim } = setup({ templates: { autoApproveSeconds: -1 } }); const template = findTemplate(db, wabaAwsId('1'), 'hello', 'en')!; sim.scheduleTemplateApproval({ ...template, status: 'PENDING' }); expect(clock.pending()).toBe(0) })
  it('rejects unknown phone numbers on inbound', async () => { const { sim } = setup(); await expect(sim.inbound({ phoneNumberId: 'phone-number-id-x', from: '+1', type: 'text', text: 'x' })).rejects.toThrow(/unknown phone number/) })
})
