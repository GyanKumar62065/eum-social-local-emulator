import type { Db } from './db.ts'
import type { MediaRow } from './types.ts'
type Row = Record<string, any>
export function insertMedia(db: Db, m: MediaRow): void { db.prepare('INSERT INTO media (media_id, owner_id, mime_type, sha256, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(m.mediaId, m.ownerId, m.mimeType, m.sha256, m.bytes, m.createdAt) }
export function getMedia(db: Db, id: string): MediaRow | undefined { const r = db.prepare('SELECT * FROM media WHERE media_id = ?').get(id) as Row | undefined; return r ? { mediaId: r.media_id, ownerId: r.owner_id, mimeType: r.mime_type, sha256: r.sha256, bytes: r.bytes, createdAt: r.created_at } : undefined }
export function deleteMedia(db: Db, id: string): void { db.prepare('DELETE FROM media WHERE media_id = ?').run(id) }
