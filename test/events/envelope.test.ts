import { describe, expect, it } from 'vitest'
import { metaError } from '../../src/domain/metaErrors.ts'
import { buildEnvelope, inboundValue, isoNanos, statusValue, templateStatusValue } from '../../src/events/envelope.ts'
import type { PhoneRow, TemplateRow, WabaRow } from '../../src/store/types.ts'

const waba: WabaRow = { id: 'waba-aa', arn: 'arn:aws:social-messaging:ap-south-1:000000000000:waba/aa', metaWabaId: '111', name: 'W', registrationStatus: 'COMPLETE', linkDate: 0, eventDestinations: [] }
const phone: PhoneRow = { id: 'phone-number-id-bb', arn: 'arn:aws:social-messaging:ap-south-1:000000000000:phone-number-id/bb', wabaId: 'waba-aa', metaPhoneNumberId: '222', phoneNumber: '+919800000001', displayPhoneNumber: '+919800000001', displayName: 'P', qualityRating: 'GREEN' }
const NOW = Date.UTC(2026, 9, 7, 10, 0, 0, 123)

describe('envelope', () => {
  it('matches the documented AWS EUM header', () => {
    const env = buildEnvelope({ waba, phone, accountId: '000000000000', now: NOW, change: { field: 'messages', value: { x: 1 } } })
    expect(env).toEqual({
      context: { MetaWabaIds: [{ wabaId: '111', arn: waba.arn }], MetaPhoneNumberIds: [{ metaPhoneNumberId: '222', arn: phone.arn }] },
      whatsAppWebhookEntry: JSON.stringify({ id: '111', changes: [{ field: 'messages', value: { x: 1 } }] }), aws_account_id: '000000000000',
      message_timestamp: '2026-10-07T10:00:00.123000000Z', messageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
    expect(typeof env.whatsAppWebhookEntry).toBe('string')
  })
  it('omits phone context for template events', () => {
    expect(buildEnvelope({ waba, accountId: '0', now: 0, change: { field: 'message_template_status_update', value: {} } }).context.MetaPhoneNumberIds).toEqual([])
  })
  it('builds status values with pricing for sent and errors for failed', () => {
    expect(statusValue(phone, { wamid: 'wamid.X', peer: '+15550001' }, 'sent', NOW, undefined, 'utility')).toEqual({
      messaging_product: 'whatsapp', metadata: { display_phone_number: '919800000001', phone_number_id: '222' },
      statuses: [{ id: 'wamid.X', status: 'sent', timestamp: String(Math.floor(NOW / 1000)), recipient_id: '15550001', pricing: { billable: true, pricing_model: 'PMP', category: 'utility', type: 'regular' } }],
    })
    const failed = statusValue(phone, { wamid: 'wamid.X', peer: '+15550001' }, 'failed', NOW, metaError(131047))
    expect((failed.statuses as any[])[0].errors[0]).toMatchObject({ code: 131047, title: 'Re-engagement message' })
    expect((failed.statuses as any[])[0]).not.toHaveProperty('pricing')
  })
  it('builds inbound and template status values', () => {
    const value = inboundValue(phone, { wamid: 'wamid.I', from: '+15550001', name: 'Asha', type: 'text', payload: { text: { body: 'STOP' } }, at: NOW })
    expect(value).toMatchObject({ contacts: [{ profile: { name: 'Asha' }, wa_id: '15550001' }], messages: [{ from: '15550001', id: 'wamid.I', type: 'text', text: { body: 'STOP' } }] })
    const template = { metaTemplateId: '123456789012345', name: 'hello', language: 'en' } as TemplateRow
    expect(templateStatusValue(template, 'REJECTED', 'INVALID_FORMAT')).toEqual({ event: 'REJECTED', message_template_id: 123456789012345, message_template_name: 'hello', message_template_language: 'en', reason: 'INVALID_FORMAT' })
  })
  it('formats nanosecond timestamps', () => { expect(isoNanos(0)).toBe('1970-01-01T00:00:00.000000000Z') })
})
