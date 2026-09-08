PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'blue', bio TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('direct','group','saved')),
  title TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id), direct_key TEXT UNIQUE,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS members (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner','member')),
  last_read INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
  muted INTEGER NOT NULL DEFAULT 0 CHECK(muted IN (0,1)), archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  PRIMARY KEY(chat_id,user_id)
) STRICT;
CREATE INDEX IF NOT EXISTS members_user ON members(user_id);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  uploader_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, mime TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size > 0), created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS files_uploader ON files(uploader_id);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id), client_id TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '', reply_to INTEGER REFERENCES messages(id),
  file_id TEXT UNIQUE REFERENCES files(id), created_at INTEGER NOT NULL, edited_at INTEGER, deleted_at INTEGER,
  UNIQUE(sender_id, client_id)
) STRICT;
CREATE INDEX IF NOT EXISTS messages_chat_id ON messages(chat_id,id DESC);
CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id), emoji TEXT NOT NULL,
  PRIMARY KEY(message_id,user_id,emoji)
) STRICT;
PRAGMA user_version = 1;
