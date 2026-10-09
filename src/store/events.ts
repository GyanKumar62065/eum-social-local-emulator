import type { Db } from './db.ts'
import type { Delivery, EventKind, EventRow } from './types.ts'
type Row = Record<string, any>
const toEvent = (r: Row): EventRow => ({ id: r.id, kind: r.kind, wabaId: r.waba_id ?? undefined, wamid: r.wamid ?? undefined, envelope: JSON.parse(r.envelope), deliveries: JSON.parse(r.deliveries), at: r.at })
export function insertEvent(db: Db, e: EventRow): void { db.prepare('INSERT INTO event (id, kind, waba_id, wamid, envelope, deliveries, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(e.id, e.kind, e.wabaId ?? null, e.wamid ?? null, JSON.stringify(e.envelope), JSON.stringify(e.deliveries), e.at) }
export function setDeliveries(db: Db, id: string, deliveries: Delivery[]): void { db.prepare('UPDATE event SET deliveries = ? WHERE id = ?').run(JSON.stringify(deliveries), id) }
export function listEvents(db: Db, f: { kind?: EventKind; wamid?: string; limit?: number }): EventRow[] {
  const where: string[] = []; const args: (string | number)[] = []
  if (f.kind) { where.push('kind = ?'); args.push(f.kind) }
  if (f.wamid) { where.push('wamid = ?'); args.push(f.wamid) }
  const sql = `SELECT * FROM event ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, rowid DESC LIMIT ?`
  return (db.prepare(sql).all(...args, f.limit ?? 200) as Row[]).map(toEvent)
}
