import type { Db } from './db.ts'
import type { Tag } from './types.ts'
export function putTags(db: Db, arn: string, tags: Tag[]): void { const stmt = db.prepare('INSERT INTO tag (resource_arn, key, value) VALUES (?, ?, ?) ON CONFLICT (resource_arn, key) DO UPDATE SET value = excluded.value'); for (const tag of tags) stmt.run(arn, tag.key, tag.value ?? null) }
export function removeTags(db: Db, arn: string, keys: string[]): void { const stmt = db.prepare('DELETE FROM tag WHERE resource_arn = ? AND key = ?'); for (const key of keys) stmt.run(arn, key) }
export function listTags(db: Db, arn: string): Tag[] { return (db.prepare('SELECT key, value FROM tag WHERE resource_arn = ? ORDER BY key').all(arn) as Record<string, any>[]).map((r) => ({ key: r.key, value: r.value ?? undefined })) }
export function deleteTagsFor(db: Db, arns: string[]): void { const stmt = db.prepare('DELETE FROM tag WHERE resource_arn = ?'); for (const arn of arns) stmt.run(arn) }
