import type { Db } from '../store/db.ts'
import { insertEvent, setDeliveries } from '../store/events.ts'
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
      try { fn(event) } catch (error) { this.o.log.error({ err: error }, 'eum-local: bus subscriber failed') }
    }
  }
  async emit(a: { kind: EventKind; waba: WabaRow; phone?: PhoneRow; wamid?: string; change: WebhookChange; now: number }): Promise<EventRow> {
    const envelope = buildEnvelope({ waba: a.waba, phone: a.phone, change: a.change, accountId: this.o.accountId, now: a.now })
    const row: EventRow = { id: envelope.messageId, kind: a.kind, wabaId: a.waba.id, wamid: a.wamid, envelope, deliveries: [], at: a.now }
    insertEvent(this.o.db, row)
    for (const { eventDestinationArn: arn } of a.waba.eventDestinations) {
      const sink = this.o.sinks.find((candidate) => candidate.accepts(arn))
      if (!sink) { row.deliveries.push({ destination: arn, ok: false, detail: 'skipped: unsupported destination' }); continue }
      try { row.deliveries.push({ destination: arn, ok: true, detail: await sink.publish(arn, envelope) }) }
      catch (error) { row.deliveries.push({ destination: arn, ok: false, detail: error instanceof Error ? error.message : String(error) }) }
    }
    if (this.o.webhookUrl) {
      try {
        const response = await fetch(this.o.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) })
        row.deliveries.push({ destination: this.o.webhookUrl, ok: response.ok, detail: `HTTP ${response.status}` })
      } catch (error) { row.deliveries.push({ destination: this.o.webhookUrl, ok: false, detail: error instanceof Error ? error.message : String(error) }) }
    }
    setDeliveries(this.o.db, row.id, row.deliveries)
    this.notify({ type: 'event', event: row })
    return row
  }
}
