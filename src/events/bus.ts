import type { Db } from '../store/db.ts'
import { appendDeliveryAttempt, getEvent, insertEvent } from '../store/events.ts'
import type { EventKind, EventRow, MessageRow, TemplateRow, WabaRow, PhoneRow } from '../store/types.ts'
import { buildEnvelope, type WebhookChange } from './envelope.ts'
import type { Sink } from './sinks.ts'

export type { Sink } from './sinks.ts'
export type BusEvent =
  | { type: 'message'; message: MessageRow }
  | { type: 'status'; wamid: string; status: string }
  | { type: 'event'; event: EventRow }
  | { type: 'template'; template: TemplateRow }
  | { type: 'waba' }
  | { type: 'reset' }
export interface BusOptions { db: Db; sinks: Sink[]; accountId: string; webhookUrl?: string; log: { error(obj: unknown, msg?: string): void } }

export class EventBus {
  private readonly o: BusOptions
  private readonly subscribers = new Set<(event: BusEvent) => void>()
  constructor(options: BusOptions) { this.o = options }
  subscribe(fn: (event: BusEvent) => void): () => void { this.subscribers.add(fn); return () => this.subscribers.delete(fn) }
  notify(event: BusEvent): void {
    for (const fn of this.subscribers) {
      try { fn(event) } catch (error) { this.o.log.error({ err: error }, 'eum-social-local-emulator: bus subscriber failed') }
    }
  }
  async emit(a: { kind: EventKind; waba: WabaRow; phone?: PhoneRow; wamid?: string; change: WebhookChange; now: number }): Promise<EventRow> {
    const envelope = buildEnvelope({ waba: a.waba, phone: a.phone, change: a.change, accountId: this.o.accountId, now: a.now })
    const destinations = [...a.waba.eventDestinations.map(({ eventDestinationArn }) => eventDestinationArn), ...(this.o.webhookUrl ? [this.o.webhookUrl] : [])]
    let row: EventRow = { id: envelope.messageId, kind: a.kind, wabaId: a.waba.id, wamid: a.wamid, envelope, deliveries: destinations.map((destination) => ({ destination, ok: false, detail: 'delivery pending', attempts: [] })), at: a.now }
    insertEvent(this.o.db, row)
    for (const destination of destinations) {
      const attempt = await this.publish(destination, envelope, a.now)
      row = appendDeliveryAttempt(this.o.db, row.id, destination, attempt) ?? row
    }
    this.notify({ type: 'event', event: row })
    return row
  }
  async replay(eventId: string, destination: string, now: number): Promise<EventRow> {
    const event = getEvent(this.o.db, eventId)
    if (!event) throw new Error(`event ${eventId} not found`)
    const delivery = event.deliveries.find((item) => item.destination === destination)
    if (!delivery) throw new Error(`destination ${destination} is not configured for event ${eventId}`)
    if (delivery.ok) throw new Error(`destination ${destination} already has a successful delivery`)
    const attempt = await this.publish(destination, event.envelope, now)
    const updated = appendDeliveryAttempt(this.o.db, eventId, destination, attempt)
    if (!updated) throw new Error(`event ${eventId} not found`)
    this.notify({ type: 'event', event: updated })
    return updated
  }
  private async publish(destination: string, envelope: EventRow['envelope'], at: number): Promise<{ at: number; ok: boolean; detail: string }> {
    try {
      if (this.o.webhookUrl === destination) {
        const response = await fetch(destination, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) })
        return { at, ok: response.ok, detail: `HTTP ${response.status}` }
      }
      const sink = this.o.sinks.find((candidate) => candidate.accepts(destination))
      if (!sink) return { at, ok: false, detail: 'skipped: unsupported destination' }
      return { at, ok: true, detail: await sink.publish(destination, envelope) }
    } catch (error) { return { at, ok: false, detail: error instanceof Error ? error.message : String(error) } }
  }
}
