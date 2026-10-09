import type { Db } from './db.ts'
import type { Delivery, DeliveryAttempt, EventKind, EventRow } from './types.ts'
type Row = Record<string, any>
const toEvent = (r: Row): EventRow => {
  const at = r.at as number
  const rawDeliveries = JSON.parse(r.deliveries) as Delivery[]
  const deliveryAttempts = rawDeliveries.map((delivery) => ({ destination: delivery.destination, attempts: Array.isArray(delivery.attempts) ? delivery.attempts : [{ at, ok: delivery.ok, detail: delivery.detail }] }))
  const deliveries = rawDeliveries.map(({ attempts: _attempts, ...delivery }) => delivery)
  return { id: r.id, kind: r.kind, wabaId: r.waba_id ?? undefined, wamid: r.wamid ?? undefined, envelope: JSON.parse(r.envelope), deliveries, deliveryAttempts, at }
}
export function insertEvent(db: Db, e: EventRow): void { db.prepare('INSERT INTO event (id, kind, waba_id, wamid, envelope, deliveries, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(e.id, e.kind, e.wabaId ?? null, e.wamid ?? null, JSON.stringify(e.envelope), JSON.stringify(e.deliveries), e.at) }
export function setDeliveries(db: Db, id: string, deliveries: Delivery[]): void { db.prepare('UPDATE event SET deliveries = ? WHERE id = ?').run(JSON.stringify(deliveries), id) }
export function getEvent(db: Db, id: string): EventRow | undefined { const r = db.prepare('SELECT * FROM event WHERE id = ?').get(id) as Row | undefined; return r ? toEvent(r) : undefined }
export function appendDeliveryAttempt(db: Db, id: string, destination: string, attempt: DeliveryAttempt): EventRow | undefined {
  const event = getEvent(db, id)
  if (!event) return undefined
  const priorAttempts = event.deliveryAttempts?.find((item) => item.destination === destination)?.attempts ?? []
  const deliveries = event.deliveries.map((delivery) => delivery.destination === destination
    ? { ...delivery, ok: attempt.ok, detail: attempt.detail, attempts: [...priorAttempts, attempt] }
    : delivery)
  setDeliveries(db, id, deliveries)
  return getEvent(db, id)
}
export function listEvents(db: Db, f: { kind?: EventKind; wamid?: string; limit?: number }): EventRow[] {
  const where: string[] = []; const args: (string | number)[] = []
  if (f.kind) { where.push('kind = ?'); args.push(f.kind) }
  if (f.wamid) { where.push('wamid = ?'); args.push(f.wamid) }
  const sql = `SELECT * FROM event ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, rowid DESC LIMIT ?`
  return (db.prepare(sql).all(...args, f.limit ?? 200) as Row[]).map(toEvent)
}
