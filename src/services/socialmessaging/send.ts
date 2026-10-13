import { randomUUID } from 'node:crypto'
import type { HandlerMap } from '../../context.ts'
import { msisdn, newWamid } from '../../domain/ids.ts'
import { renderOutbound } from '../../domain/render.ts'
import { checkTemplateSend, resolveDocumentHeader } from '../../domain/templates.ts'
import { invalid } from '../../smithy/errors.ts'
import { insertMessage } from '../../store/messages.ts'
import { findTemplate } from '../../store/templates.ts'
import type { MessageRow } from '../../store/types.ts'
import { requirePhone } from './waba.ts'

export const sendHandlers: HandlerMap = {
  SendWhatsAppMessage(input, ctx) {
    const { phone, waba } = requirePhone(ctx, input.originationPhoneNumberId)
    if (waba.registrationStatus !== 'COMPLETE') throw invalid(`WhatsApp Business Account ${waba.id} has not finished setup`)
    if (!/^v\d+\.\d+$/.test(input.metaApiVersion)) throw invalid(`metaApiVersion must look like v20.0, got ${input.metaApiVersion}`)
    let body: any
    try { body = JSON.parse(Buffer.from(input.message).toString('utf8')) }
    catch { throw invalid('message is not valid JSON') }
    if (body?.messaging_product !== 'whatsapp') throw invalid('message must set "messaging_product": "whatsapp"')
    const peer = typeof body.to === 'string' ? msisdn(body.to) : ''
    if (!peer) throw invalid('message must set "to" to the recipient phone number')
    if (typeof body.type !== 'string' || !body.type) throw invalid('message must set "type"')
    if (!['text', 'template', 'image', 'document', 'audio', 'video', 'sticker', 'reaction', 'interactive', 'location', 'contacts'].includes(body.type)) throw invalid(`unsupported WhatsApp message type ${body.type}`)
    const template = body.type === 'template' && body.template?.name ? findTemplate(ctx.db, waba.id, String(body.template.name), String(body.template.language?.code ?? '')) : undefined
    const documentHeader = body.type === 'template' && template?.status === 'APPROVED' ? resolveDocumentHeader(template, body, ctx.db, phone.id) : undefined
    if (body.type === 'template') {
      const templateError = checkTemplateSend(template, body)
      if (templateError?.code === 132001) throw invalid(`WhatsApp template send rejected (${templateError.code}): ${templateError.title}`)
    }
    const wamid = newWamid()
    const awsMessageId = ctx.config.messageIdMode === 'wamid' ? wamid : randomUUID()
    const message: MessageRow = {
      wamid, awsMessageId, phoneNumberId: phone.id,
      direction: 'out', peer, type: body.type, body, renderedText: renderOutbound(body, template),
      category: body.type === 'template' ? (template?.category.toLowerCase() ?? 'utility') : 'service', status: 'accepted', createdAt: ctx.clock.now(),
      trace: {
        operation: 'SendWhatsAppMessage',
        request: redactTrace({ originationPhoneNumberId: input.originationPhoneNumberId, metaApiVersion: input.metaApiVersion, message: body }),
        response: { messageId: awsMessageId },
        ...(template ? { template: { name: template.name, language: template.language, generation: template.generation, headerFormat: template.components.find((component) => String(component.type).toUpperCase() === 'HEADER')?.format, components: template.components } } : {}),
        ...(documentHeader ? { mediaValidation: { result: 'valid' as const, mediaId: documentHeader.media.mediaId, filename: documentHeader.filename, mimeType: documentHeader.media.mimeType, size: documentHeader.media.bytes.byteLength, sha256: documentHeader.media.sha256 } } : {}),
      },
    }
    const outcome = ctx.sim.decide(message, template)
    if (outcome.requestError) throw outcome.requestError
    insertMessage(ctx.db, message)
    ctx.bus.notify({ type: 'message', message })
    ctx.sim.onSend(message, template, outcome)
    return { messageId: message.awsMessageId }
  },
}

function redactTrace(value: unknown, key = ''): any {
  if (/authorization|auth.?token|bearer|credential|secret|password|session.?token|access.?token|api.?key/i.test(key)) return '[redacted]'
  if (Array.isArray(value)) return value.map((item) => redactTrace(item))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactTrace(child, childKey)]))
  return value
}
