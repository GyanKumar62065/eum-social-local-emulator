import { DisassociateWhatsAppBusinessAccountCommand, GetLinkedWhatsAppBusinessAccountPhoneNumberCommand, SendWhatsAppMessageCommand } from '@aws-sdk/client-socialmessaging'
import { afterEach, describe, expect, it } from 'vitest'
import { getMessage, listMessages } from '../../src/store/messages.ts'
import { entry, PHONE_ID, startHarness, TEST_TOPIC, utf8, WABA_ID, type Harness } from '../helpers.ts'
let h: Harness
afterEach(async () => { await h.close() })
const template = (to: string, params: string[]) => utf8(JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: { name: 'invoice_reminder', language: { code: 'en' }, components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] } }))
const PARAMS = ['Asha', 'INV-1042', '₹12,000', '9 Oct']
const send = (message: Uint8Array, originationPhoneNumberId = PHONE_ID) => h.client.send(new SendWhatsAppMessageCommand({ originationPhoneNumberId, message, metaApiVersion: 'v20.0' }))
const statuses = () => h.published.map((item) => entry(item.envelope).changes[0].value.statuses?.[0]).filter(Boolean)
describe('SendWhatsAppMessage', () => {
  it('returns a messageId, renders the template and emits sent → delivered → read on SNS', async () => {
    h = await startHarness(); const result = await send(template('+15550001', PARAMS)); expect(result.messageId).toMatch(/^[0-9a-f-]{36}$/)
    const [message] = listMessages(h.app.ctx.db, {}); expect(message).toMatchObject({ awsMessageId: result.messageId, peer: '+15550001', renderedText: 'Hi Asha, invoice INV-1042 of ₹12,000 is due on 9 Oct.', category: 'utility', status: 'accepted' })
    await h.clock.advance(3000); expect(statuses().map((status) => status.status)).toEqual(['sent', 'delivered', 'read']); expect(statuses()[0]).toMatchObject({ id: message.wamid, recipient_id: '15550001', pricing: { category: 'utility', billable: true } })
    expect(h.published[0].arn).toBe(TEST_TOPIC); expect(h.published[0].envelope.context.MetaPhoneNumberIds).toEqual([{ metaPhoneNumberId: '200000000000001', arn: expect.stringContaining(':phone-number-id/') }]); expect(getMessage(h.app.ctx.db, message.wamid)?.status).toBe('read')
  })
  it('accepts the phone number ARN as originationPhoneNumberId (Review Focus 1)', async () => { h = await startHarness(); const arn = (await h.client.send(new GetLinkedWhatsAppBusinessAccountPhoneNumberCommand({ id: PHONE_ID }))).phoneNumber!.arn!; await expect(send(template('+15550001', PARAMS), arn)).resolves.toMatchObject({ messageId: expect.any(String) }) })
  it('returns the wamid when messageIdMode is wamid', async () => { h = await startHarness({ messageIdMode: 'wamid' }); expect((await send(template('+15550001', PARAMS))).messageId).toMatch(/^wamid\./) })
  it('fails asynchronously with 132000 on a parameter mismatch', async () => { h = await startHarness(); await send(template('+15550001', ['only-one'])); await h.clock.advance(1000); expect(statuses()).toEqual([expect.objectContaining({ status: 'failed', errors: [expect.objectContaining({ code: 132000 })] })]) })
  it('fails free-form text with 131047 outside the 24h window', async () => { h = await startHarness(); await send(utf8(JSON.stringify({ messaging_product: 'whatsapp', to: '+15550001', type: 'text', text: { body: 'hello' } }))); await h.clock.advance(1000); expect(statuses()[0]).toMatchObject({ status: 'failed', errors: [{ code: 131047 }] }) })
  it('applies a failure rule from config', async () => { h = await startHarness({ sim: { defaultFlow: ['sent', 'delivered', 'read'], stepDelayMs: 1000, rules: [{ match: { to: '*0000' }, outcome: { status: 'failed', code: 131026 } }] } }); await send(template('+15550000', PARAMS)); await h.clock.advance(1000); expect(statuses()[0]).toMatchObject({ status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable' }] }) })
  it('rejects malformed Meta payloads synchronously', async () => {
    h = await startHarness()
    for (const [message, pattern] of [[utf8('not json'), /not valid JSON/], [utf8(JSON.stringify({ to: '+1', type: 'text' })), /messaging_product/], [utf8(JSON.stringify({ messaging_product: 'whatsapp', type: 'text' })), /"to"/], [utf8(JSON.stringify({ messaging_product: 'whatsapp', to: 'abc', type: 'text' })), /"to"/]] as const) {
      const error = await send(message).catch((caught) => caught); expect(error.name).toBe('InvalidParametersException'); expect(error.message).toMatch(pattern)
    }
    const badVersion = await h.client.send(new SendWhatsAppMessageCommand({ originationPhoneNumberId: PHONE_ID, message: template('+1', PARAMS), metaApiVersion: 'latest' })).catch((error) => error); expect(badVersion.message).toMatch(/metaApiVersion/)
  })
  it('returns ResourceNotFoundException for unknown and disassociated numbers (Review Focus 2)', async () => {
    h = await startHarness(); expect((await send(template('+1', PARAMS), 'phone-number-id-nope').catch((error) => error)).name).toBe('ResourceNotFoundException'); await send(template('+15550001', PARAMS)); await h.client.send(new DisassociateWhatsAppBusinessAccountCommand({ id: WABA_ID })); await h.clock.advance(5000); expect(h.published).toEqual([]); expect((await send(template('+1', PARAMS)).catch((error) => error)).name).toBe('ResourceNotFoundException')
  })
})
