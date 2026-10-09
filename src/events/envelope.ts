import { randomUUID } from 'node:crypto'
import type { StatusName } from '../config.ts'
import { digits } from '../domain/ids.ts'
import { META_ERRORS_HREF, type MetaError } from '../domain/metaErrors.ts'
import type { PhoneRow, TemplateRow, WabaRow } from '../store/types.ts'

export interface Envelope {
  context: { MetaWabaIds: { wabaId: string; arn: string }[]; MetaPhoneNumberIds: { metaPhoneNumberId: string; arn: string }[] }
  whatsAppWebhookEntry: string; aws_account_id: string; message_timestamp: string; messageId: string
}
export interface WebhookChange { field: 'messages' | 'message_template_status_update'; value: Record<string, unknown> }
export const isoNanos = (ms: number): string => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z')

export function buildEnvelope(a: { waba: WabaRow; phone?: PhoneRow; change: WebhookChange; accountId: string; now: number }): Envelope {
  return {
    context: { MetaWabaIds: [{ wabaId: a.waba.metaWabaId, arn: a.waba.arn }], MetaPhoneNumberIds: a.phone ? [{ metaPhoneNumberId: a.phone.metaPhoneNumberId, arn: a.phone.arn }] : [] },
    whatsAppWebhookEntry: JSON.stringify({ id: a.waba.metaWabaId, changes: [a.change] }), aws_account_id: a.accountId,
    message_timestamp: isoNanos(a.now), messageId: randomUUID(),
  }
}

const metadata = (phone: PhoneRow) => ({ display_phone_number: digits(phone.phoneNumber), phone_number_id: phone.metaPhoneNumberId })
const seconds = (ms: number) => String(Math.floor(ms / 1000))

export function statusValue(phone: PhoneRow, msg: { wamid: string; peer: string }, status: StatusName, at: number, failure?: MetaError, category?: string): Record<string, unknown> {
  const result: Record<string, unknown> = { id: msg.wamid, status, timestamp: seconds(at), recipient_id: digits(msg.peer) }
  if (status === 'sent' || status === 'delivered') {
    const messageCategory = category ?? 'service'
    result.pricing = { billable: messageCategory !== 'service', pricing_model: 'PMP', category: messageCategory, type: 'regular' }
  }
  if (failure) result.errors = [{ code: failure.code, title: failure.title, message: failure.title, error_data: { details: failure.title }, href: META_ERRORS_HREF }]
  return { messaging_product: 'whatsapp', metadata: metadata(phone), statuses: [result] }
}

export function inboundValue(phone: PhoneRow, m: { wamid: string; from: string; name: string; type: string; payload: Record<string, unknown>; at: number }): Record<string, unknown> {
  return { messaging_product: 'whatsapp', metadata: metadata(phone), contacts: [{ profile: { name: m.name }, wa_id: digits(m.from) }], messages: [{ from: digits(m.from), id: m.wamid, timestamp: seconds(m.at), type: m.type, ...m.payload }] }
}

export function templateStatusValue(template: TemplateRow, event: string, reason?: string): Record<string, unknown> {
  return { event, message_template_id: Number(template.metaTemplateId), message_template_name: template.name, message_template_language: template.language, reason: reason ?? 'NONE' }
}
