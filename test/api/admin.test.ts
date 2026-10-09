import { SendWhatsAppMessageCommand } from '@aws-sdk/client-socialmessaging'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { entry, PHONE_ID, startHarness, utf8, WABA_ID, type Harness } from '../helpers.ts'
let h: Harness
beforeEach(async () => { h = await startHarness() })
afterEach(async () => { await h.close() })
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${h.url}/_eum/api${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, json: await response.json() as any }
}
const sendTemplate = () => h.client.send(new SendWhatsAppMessageCommand({ originationPhoneNumberId: PHONE_ID, metaApiVersion: 'v20.0', message: utf8(JSON.stringify({ messaging_product: 'whatsapp', to: '+15550001', type: 'template', template: { name: 'invoice_reminder', language: { code: 'en' }, components: [{ type: 'body', parameters: ['a', 'b', 'c', 'd'].map((text) => ({ type: 'text', text })) }] } })) }))
describe('admin API', () => {
  it('reports coverage and model provenance', async () => { const { json } = await api('GET', '/coverage'); expect(json.simulated).toContain('SendWhatsAppMessage'); expect(json.notSimulated).toContain('CreateWhatsAppFlow'); expect(json.model.commit).toMatch(/^[0-9a-f]{7}$/) })
  it('lists WABAs with phones and creates new ones', async () => {
    expect((await api('GET', '/wabas')).json.wabas[0]).toMatchObject({ id: WABA_ID, phoneNumbers: [{ id: PHONE_ID }] })
    const created = await api('POST', '/wabas', { name: 'Second', phoneNumbers: [{ phoneNumber: '+919800000002', displayName: 'Two' }] }); expect(created.status).toBe(201); expect((await api('GET', '/wabas')).json.wabas).toHaveLength(2); expect((await api('POST', '/wabas', { phoneNumbers: [] })).status).toBe(400)
  })
  it('shows a message with history and events, and pushes a manual status', async () => {
    await sendTemplate(); await h.clock.advance(1000); const [message] = (await api('GET', '/messages')).json.messages
    const pushed = await api('POST', `/messages/${message.wamid}/status`, { status: 'failed', code: 131050 }); expect(pushed.json.message).toMatchObject({ status: 'failed', errorCode: 131050 })
    const detail = (await api('GET', `/messages/${message.wamid}`)).json; expect(detail.history.map((item: any) => item.status)).toEqual(['accepted', 'sent', 'failed']); expect(detail.events).toHaveLength(2); expect(entry(h.published.at(-1)!.envelope).changes[0].value.statuses[0].errors[0].code).toBe(131050)
    expect((await api('POST', `/messages/${message.wamid}/status`, { status: 'bogus' })).status).toBe(400); expect((await api('POST', '/messages/wamid.none/status', { status: 'read' })).status).toBe(404)
  })
  it('accepts inbound customer messages, including STOP', async () => {
    const result = await api('POST', '/inbound', { phoneNumberId: PHONE_ID, from: '+15550001', type: 'text', text: 'STOP' }); expect(result.status).toBe(201); expect(entry(h.published.at(-1)!.envelope).changes[0].value.messages[0].text.body).toBe('STOP')
    expect((await api('POST', '/inbound', { phoneNumberId: 'phone-number-id-x', from: '+1', type: 'text', text: 'x' })).status).toBe(404); expect((await api('POST', '/inbound', { phoneNumberId: PHONE_ID, from: '+1', type: 'video' })).status).toBe(400)
  })
  it('approves and rejects templates by hand', async () => {
    const [template] = (await api('GET', '/templates')).json.templates; const result = await api('POST', `/templates/${template.metaTemplateId}/reject`, { reason: 'INVALID_FORMAT' }); expect(result.json.template.status).toBe('REJECTED'); expect(entry(h.published.at(-1)!.envelope).changes[0].value).toMatchObject({ event: 'REJECTED', reason: 'INVALID_FORMAT' }); expect((await api('POST', '/templates/999/approve', {})).status).toBe(404)
  })
  it('serves stored media bytes', async () => {
    const message = await h.app.ctx.sim.inbound({ phoneNumberId: PHONE_ID, from: '+1555', type: 'image', mediaBase64: Buffer.from('img').toString('base64'), mimeType: 'image/png' }); const response = await fetch(`${h.url}/_eum/api/media/${message.body.image.id}`); expect(response.headers.get('content-type')).toBe('image/png'); expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('img')
  })
  it('resets data, cancels scheduled deliveries and re-seeds (Review Focus 2)', async () => {
    await sendTemplate(); expect((await api('POST', '/reset', {})).json).toEqual({ ok: true }); await h.clock.advance(10_000); expect(h.published).toEqual([]); expect((await api('GET', '/messages')).json.messages).toEqual([]); expect((await api('GET', '/wabas')).json.wabas[0].id).toBe(WABA_ID)
  })
  it('streams bus events over SSE', async () => {
    const controller = new AbortController(); const response = await fetch(`${h.url}/_eum/api/stream`, { signal: controller.signal }); const reader = response.body!.getReader(); await reader.read()
    await api('POST', '/inbound', { phoneNumberId: PHONE_ID, from: '+15550001', type: 'text', text: 'hi' }); let streamText = ''
    while (!streamText.includes('event: message')) streamText += new TextDecoder().decode((await reader.read()).value)
    expect(streamText).toContain('event: event'); controller.abort()
  })
})
