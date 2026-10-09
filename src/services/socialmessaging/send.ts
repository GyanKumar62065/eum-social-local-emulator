import { randomUUID } from 'node:crypto'
import type { HandlerMap } from '../../context.ts'
import { msisdn, newWamid } from '../../domain/ids.ts'
import { renderOutbound } from '../../domain/render.ts'
import { checkTemplateSend } from '../../domain/templates.ts'
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
    if (body.type === 'template') {
      const templateError = checkTemplateSend(template, body)
      if (templateError?.code === 132001) throw invalid(`WhatsApp template send rejected (${templateError.code}): ${templateError.title}`)
    }
    const wamid = newWamid()
    const message: MessageRow = {
      wamid, awsMessageId: ctx.config.messageIdMode === 'wamid' ? wamid : randomUUID(), phoneNumberId: phone.id,
      direction: 'out', peer, type: body.type, body, renderedText: renderOutbound(body, template),
      category: body.type === 'template' ? (template?.category.toLowerCase() ?? 'utility') : 'service', status: 'accepted', createdAt: ctx.clock.now(),
    }
    const outcome = ctx.sim.decide(message, template)
    if (outcome.requestError) throw outcome.requestError
    insertMessage(ctx.db, message)
    ctx.bus.notify({ type: 'message', message })
    ctx.sim.onSend(message, template, outcome)
    return { messageId: message.awsMessageId }
  },
}
