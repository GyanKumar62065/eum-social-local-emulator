import type { MetaError } from '../domain/metaErrors.ts'
import type { Db } from './db.ts'
import type { MessageRow, MessageStatus, StatusHistoryRow } from './types.ts'
type Row = Record<string, any>
const toMessage = (r: Row): MessageRow => ({ wamid: r.wamid, awsMessageId: r.aws_message_id ?? undefined, phoneNumberId: r.phone_number_id, direction: r.direction, peer: r.peer, type: r.type, body: JSON.parse(r.body), renderedText: r.rendered_text ?? undefined, category: r.category ?? undefined, status: r.status, errorCode: r.error_code ?? undefined, errorTitle: r.error_title ?? undefined, createdAt: r.created_at })
export function insertMessage(db: Db, m: MessageRow): void {
  db.prepare('INSERT INTO message (wamid, aws_message_id, phone_number_id, direction, peer, type, body, rendered_text, category, status, error_code, error_title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(m.wamid, m.awsMessageId ?? null, m.phoneNumberId, m.direction, m.peer, m.type, JSON.stringify(m.body), m.renderedText ?? null, m.category ?? null, m.status, m.errorCode ?? null, m.errorTitle ?? null, m.createdAt)
  db.prepare('INSERT INTO message_status (wamid, status, error_code, at) VALUES (?, ?, ?, ?)').run(m.wamid, m.status, m.errorCode ?? null, m.createdAt)
}
export function getMessage(db: Db, wamid: string): MessageRow | undefined { const r = db.prepare('SELECT * FROM message WHERE wamid = ?').get(wamid) as Row | undefined; return r ? toMessage(r) : undefined }
export function updateMessageStatus(db: Db, wamid: string, status: MessageStatus, failure: MetaError | undefined, at: number): void {
  db.prepare('UPDATE message SET status = ?, error_code = ?, error_title = ? WHERE wamid = ?').run(status, failure?.code ?? null, failure?.title ?? null, wamid)
  db.prepare('INSERT INTO message_status (wamid, status, error_code, at) VALUES (?, ?, ?, ?)').run(wamid, status, failure?.code ?? null, at)
}
export function statusHistory(db: Db, wamid: string): StatusHistoryRow[] { return (db.prepare('SELECT status, error_code, at FROM message_status WHERE wamid = ? ORDER BY id').all(wamid) as Row[]).map((r) => ({ status: r.status, errorCode: r.error_code ?? undefined, at: r.at })) }
export function listMessages(db: Db, f: { phoneNumberId?: string; peer?: string; status?: string; limit?: number }): MessageRow[] {
  const where: string[] = []; const args: (string | number)[] = []
  if (f.phoneNumberId) { where.push('phone_number_id = ?'); args.push(f.phoneNumberId) }
  if (f.peer) { where.push('peer = ?'); args.push(f.peer) }
  if (f.status) { where.push('status = ?'); args.push(f.status) }
  const sql = `SELECT * FROM message ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`
  return (db.prepare(sql).all(...args, f.limit ?? 500) as Row[]).map(toMessage)
}
export function lastInboundAt(db: Db, phoneNumberId: string, peer: string): number | undefined { const r = db.prepare("SELECT max(created_at) AS at FROM message WHERE phone_number_id = ? AND peer = ? AND direction = 'in'").get(phoneNumberId, peer) as Row; return r.at ?? undefined }
