import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, chmodSync } from 'node:fs';
import path from 'node:path';

export function openDatabase(dataDir) {
  mkdirSync(path.join(dataDir, 'uploads'), { recursive: true, mode: 0o700 });
  const filename = path.join(dataDir, 'messa.sqlite');
  const db = new DatabaseSync(filename);
  chmodSync(filename, 0o600);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 1) throw new Error('Database version is newer than this server.');
  if (version < 1) {
    db.exec('BEGIN IMMEDIATE');
    try { db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  db.function('unicode_lower', { deterministic: true }, value => String(value ?? '').toLocaleLowerCase('ru'));
  return db;
}
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export const publicUser = row => ({ id: row.id, username: row.username, displayName: row.display_name, color: row.color, bio: row.bio });
