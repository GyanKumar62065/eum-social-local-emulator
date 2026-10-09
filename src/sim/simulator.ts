import { createHash } from 'node:crypto'
import type { Config, StatusName } from '../config.ts'
import { metaNumericId, msisdn, newWamid } from '../domain/ids.ts'
import { metaError, type MetaError } from '../domain/metaErrors.ts'
import { checkTemplateSend } from '../domain/templates.ts'
import type { EventBus } from '../events/bus.ts'
import { inboundValue, statusValue, templateStatusValue } from '../events/envelope.ts'
import type { Db } from '../store/db.ts'
import { insertMedia } from '../store/media.ts'
import { getMessage, insertMessage, lastInboundAt, updateMessageStatus } from '../store/messages.ts'
import { getTemplateById, listPendingTemplates, setTemplateStatus } from '../store/templates.ts'
import type { MessageRow, TemplateRow } from '../store/types.ts'
import { getPhone, getWaba } from '../store/wabas.ts'
import type { Clock } from './clock.ts'
import { decideOutcome, type Outcome } from './rules.ts'
import { windowOpen } from './window.ts'

export interface InboundInput {
  phoneNumberId: string; from: string; name?: string
  type: 'text' | 'button' | 'image' | 'interactive'
  text?: string; payload?: string; mediaBase64?: string; mimeType?: string
  interactiveType?: 'button_reply' | 'list_reply'; id?: string; title?: string; description?: string
  contextMessageId?: string
}
interface SimDeps { db: Db; clock: Clock; bus: EventBus; config: Config }

export class Simulator {
  private readonly d: SimDeps
  constructor(deps: SimDeps) { this.d = deps }
  onSend(msg: MessageRow, template: TemplateRow | undefined, outcome = this.decide(msg, template)): void {
    outcome.flow.forEach((status, index) => {
      this.d.clock.schedule((index + 1) * this.d.config.sim.stepDelayMs, async () => { await this.applyStatus(msg.wamid, status, status === 'failed' ? outcome.failure : undefined) })
    })
  }
  decide(msg: MessageRow, template: TemplateRow | undefined): Outcome {
    if (msg.type === 'template') {
      const failure = checkTemplateSend(template, msg.body)
      if (failure) return { flow: ['failed'], failure }
    } else if (!windowOpen(lastInboundAt(this.d.db, msg.phoneNumberId, msg.peer), this.d.clock.now())) return { flow: ['failed'], failure: metaError(131047) }
    return decideOutcome(this.d.config.sim.rules, this.d.config.sim.defaultFlow, { to: msg.peer, type: msg.type, template: msg.body?.template?.name })
  }
  async applyStatus(wamid: string, status: StatusName, failure?: MetaError): Promise<MessageRow | undefined> {
    const { db, clock, bus } = this.d
    const message = getMessage(db, wamid)
    const phone = message && getPhone(db, message.phoneNumberId)
    const waba = phone && getWaba(db, phone.wabaId)
    if (!message || !phone || !waba) return undefined
    const now = clock.now()
    const error = status === 'failed' ? (failure ?? metaError(131026)) : undefined
    updateMessageStatus(db, wamid, status, error, now)
    await bus.emit({ kind: 'status', waba, phone, wamid, now, change: { field: 'messages', value: statusValue(phone, message, status, now, error, message.category) } })
    bus.notify({ type: 'status', wamid, status })
    return getMessage(db, wamid)
  }
  async inbound(input: InboundInput): Promise<MessageRow> {
    const { db, clock, bus } = this.d
    const phone = getPhone(db, input.phoneNumberId)
    const waba = phone && getWaba(db, phone.wabaId)
    if (!phone || !waba) throw new Error(`unknown phone number ${input.phoneNumberId}`)
    const peer = msisdn(input.from)
    if (!peer) throw new Error(`invalid customer number ${input.from}`)
    if (input.contextMessageId) {
      const quoted = getMessage(db, input.contextMessageId)
      if (!quoted || quoted.direction !== 'out' || quoted.phoneNumberId !== phone.id || quoted.peer !== peer) {
        throw new Error('context message must belong to the same phone number and customer')
      }
    }
    const now = clock.now()
    const wamid = newWamid()
    let payload: Record<string, unknown>
    let renderedText = input.text ?? ''
    if (input.type === 'image') {
      const bytes = Buffer.from(input.mediaBase64 ?? '', 'base64')
      const mimeType = input.mimeType ?? 'image/jpeg'
      const mediaId = metaNumericId()
      const sha256 = createHash('sha256').update(bytes).digest('base64')
      insertMedia(db, { mediaId, ownerId: phone.id, mimeType, sha256, bytes, createdAt: now })
      payload = { image: { mime_type: mimeType, sha256, id: mediaId, ...(input.text ? { caption: input.text } : {}) } }
      renderedText = `[image] ${input.text ?? ''}`.trim()
    } else if (input.type === 'button') {
      if (!input.text || input.payload === undefined) throw new Error('button messages require separate text and payload values')
      payload = { button: { text: input.text, payload: input.payload } }
    }
    else if (input.type === 'interactive') {
      if (input.interactiveType === 'button_reply' && input.id && input.title) payload = { interactive: { type: 'button_reply', button_reply: { id: input.id, title: input.title } } }
      else if (input.interactiveType === 'list_reply' && input.id && input.title) payload = { interactive: { type: 'list_reply', list_reply: { id: input.id, title: input.title, ...(input.description !== undefined ? { description: input.description } : {}) } } }
      else throw new Error('interactiveType must be button_reply or list_reply')
      renderedText = input.title ?? ''
    } else payload = { text: { body: input.text ?? '' } }
    if (input.contextMessageId) payload.context = { id: input.contextMessageId }
    const message: MessageRow = { wamid, phoneNumberId: phone.id, direction: 'in', peer, type: input.type, body: payload, renderedText, status: 'received', createdAt: now }
    insertMessage(db, message)
    await bus.emit({ kind: 'inbound', waba, phone, wamid, now, change: { field: 'messages', value: inboundValue(phone, { wamid, from: peer, name: input.name ?? 'Customer', type: input.type, payload, at: now, contextMessageId: input.contextMessageId }) } })
    bus.notify({ type: 'message', message })
    return message
  }
  scheduleTemplateApproval(template: TemplateRow): void {
    const seconds = this.d.config.templates.autoApproveSeconds
    if (seconds < 0) return
    this.d.clock.schedule(seconds * 1000, async () => {
      const current = getTemplateById(this.d.db, template.metaTemplateId)
      if (current?.status === 'PENDING' && current.generation === (template.generation ?? 1)) await this.setTemplateStatus(template.metaTemplateId, 'APPROVED', undefined, template.generation ?? 1)
    })
  }
  async setTemplateStatus(id: string, status: 'APPROVED' | 'REJECTED' | 'PAUSED' | 'DISABLED', reason: string | undefined, expectedGeneration: number): Promise<TemplateRow> {
    const { db, clock, bus } = this.d
    const template = getTemplateById(db, id)
    const waba = template && getWaba(db, template.wabaId)
    if (!template || !waba) throw new Error(`unknown template ${id}`)
    if ((template.generation ?? 1) !== expectedGeneration) throw new Error(`template ${id} has changed; refresh before applying a decision`)
    const now = clock.now()
    setTemplateStatus(db, id, status, now, expectedGeneration, reason)
    await bus.emit({ kind: 'template_status', waba, now, change: { field: 'message_template_status_update', value: templateStatusValue(template, status, reason) } })
    const updated = getTemplateById(db, id)!
    bus.notify({ type: 'template', template: updated })
    return updated
  }
  resumePendingTemplates(): void { for (const template of listPendingTemplates(this.d.db)) this.scheduleTemplateApproval(template) }
}
