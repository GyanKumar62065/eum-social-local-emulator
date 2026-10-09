import type { Db } from './db.ts'
import type { PhoneRow, WabaRow } from './types.ts'

type Row = Record<string, any>
const toWaba = (r: Row): WabaRow => ({ id: r.id, arn: r.arn, metaWabaId: r.meta_waba_id, name: r.name, registrationStatus: r.registration_status, linkDate: r.link_date, eventDestinations: JSON.parse(r.event_destinations), associateToken: r.associate_token ?? undefined })
const toPhone = (r: Row): PhoneRow => ({ id: r.id, arn: r.arn, wabaId: r.waba_id, metaPhoneNumberId: r.meta_phone_number_id, phoneNumber: r.phone_number, displayPhoneNumber: r.display_phone_number, displayName: r.display_name, qualityRating: r.quality_rating, dataLocalizationRegion: r.data_localization_region ?? undefined, callSettings: r.call_settings ? JSON.parse(r.call_settings) : undefined })

export function insertWaba(db: Db, w: WabaRow): void {
  db.prepare('INSERT INTO waba (id, arn, meta_waba_id, name, registration_status, link_date, event_destinations, associate_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(w.id, w.arn, w.metaWabaId, w.name, w.registrationStatus, w.linkDate, JSON.stringify(w.eventDestinations), w.associateToken ?? null)
}
export function getWaba(db: Db, id: string): WabaRow | undefined { const r = db.prepare('SELECT * FROM waba WHERE id = ?').get(id) as Row | undefined; return r ? toWaba(r) : undefined }
export function getWabaByMeta(db: Db, id: string): WabaRow | undefined { const r = db.prepare('SELECT * FROM waba WHERE meta_waba_id = ?').get(id) as Row | undefined; return r ? toWaba(r) : undefined }
export function getWabaByToken(db: Db, token: string): WabaRow | undefined { const r = db.prepare('SELECT * FROM waba WHERE associate_token = ?').get(token) as Row | undefined; return r ? toWaba(r) : undefined }
export function listWabas(db: Db): WabaRow[] { return (db.prepare('SELECT * FROM waba ORDER BY link_date, id').all() as Row[]).map(toWaba) }
export function updateWaba(db: Db, w: WabaRow): void { db.prepare('UPDATE waba SET name = ?, registration_status = ?, event_destinations = ?, associate_token = ? WHERE id = ?').run(w.name, w.registrationStatus, JSON.stringify(w.eventDestinations), w.associateToken ?? null, w.id) }
export function deleteWaba(db: Db, id: string): void { db.prepare('DELETE FROM waba WHERE id = ?').run(id) }
export function insertPhone(db: Db, p: PhoneRow): void {
  db.prepare('INSERT INTO phone_number (id, arn, waba_id, meta_phone_number_id, phone_number, display_phone_number, display_name, quality_rating, data_localization_region, call_settings) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(p.id, p.arn, p.wabaId, p.metaPhoneNumberId, p.phoneNumber, p.displayPhoneNumber, p.displayName, p.qualityRating, p.dataLocalizationRegion ?? null, p.callSettings === undefined ? null : JSON.stringify(p.callSettings))
}
export function getPhone(db: Db, id: string): PhoneRow | undefined { const r = db.prepare('SELECT * FROM phone_number WHERE id = ?').get(id) as Row | undefined; return r ? toPhone(r) : undefined }
export function listPhones(db: Db, wabaId: string): PhoneRow[] { return (db.prepare('SELECT * FROM phone_number WHERE waba_id = ? ORDER BY phone_number').all(wabaId) as Row[]).map(toPhone) }
export function updatePhoneCallSettings(db: Db, id: string, settings: unknown): void { db.prepare('UPDATE phone_number SET call_settings = ? WHERE id = ?').run(JSON.stringify(settings), id) }
