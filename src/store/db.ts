import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type Db = DatabaseSync

const SCHEMA = `
CREATE TABLE IF NOT EXISTS waba (id TEXT PRIMARY KEY, arn TEXT NOT NULL UNIQUE, meta_waba_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, registration_status TEXT NOT NULL, link_date INTEGER NOT NULL, event_destinations TEXT NOT NULL DEFAULT '[]', associate_token TEXT);
CREATE TABLE IF NOT EXISTS phone_number (id TEXT PRIMARY KEY, arn TEXT NOT NULL UNIQUE, waba_id TEXT NOT NULL REFERENCES waba(id) ON DELETE CASCADE, meta_phone_number_id TEXT NOT NULL UNIQUE, phone_number TEXT NOT NULL, display_phone_number TEXT NOT NULL, display_name TEXT NOT NULL, quality_rating TEXT NOT NULL DEFAULT 'GREEN', data_localization_region TEXT, call_settings TEXT);
CREATE TABLE IF NOT EXISTS template (meta_template_id TEXT PRIMARY KEY, waba_id TEXT NOT NULL REFERENCES waba(id) ON DELETE CASCADE, name TEXT NOT NULL, language TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL, parameter_format TEXT NOT NULL DEFAULT 'POSITIONAL', components TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (waba_id, name, language));
CREATE TABLE IF NOT EXISTS message (wamid TEXT PRIMARY KEY, aws_message_id TEXT UNIQUE, phone_number_id TEXT NOT NULL REFERENCES phone_number(id) ON DELETE CASCADE, direction TEXT NOT NULL CHECK (direction IN ('out', 'in')), peer TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL, rendered_text TEXT, category TEXT, status TEXT NOT NULL, error_code INTEGER, error_title TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS message_thread ON message (phone_number_id, peer, created_at);
CREATE TABLE IF NOT EXISTS message_status (id INTEGER PRIMARY KEY AUTOINCREMENT, wamid TEXT NOT NULL REFERENCES message(wamid) ON DELETE CASCADE, status TEXT NOT NULL, error_code INTEGER, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS media (media_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, mime_type TEXT NOT NULL, sha256 TEXT NOT NULL, bytes BLOB NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tag (resource_arn TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (resource_arn, key));
CREATE TABLE IF NOT EXISTS event (id TEXT PRIMARY KEY, kind TEXT NOT NULL, waba_id TEXT, wamid TEXT, envelope TEXT NOT NULL, deliveries TEXT NOT NULL DEFAULT '[]', at INTEGER NOT NULL);
`

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)
  return db
}

export function resetDb(db: Db): void {
  db.exec('DELETE FROM event; DELETE FROM tag; DELETE FROM media; DELETE FROM message_status; DELETE FROM message; DELETE FROM template; DELETE FROM phone_number; DELETE FROM waba;')
}
