import { fail } from './security.mjs';

/** SSE carries hints, not the only copy of data. Clients reconcile from SQLite on every reconnect. */
export class EventHub {
  connections = new Map();
  constructor(db, config) { this.db = db; this.config = config; }
  online(id) { return !!this.connections.get(id)?.size; }
  contacts(userId) {
    return this.db.prepare('SELECT DISTINCT other.user_id FROM members own JOIN members other ON own.chat_id=other.chat_id WHERE own.user_id=?').all(userId).map(x => x.user_id);
  }
  send(userId, event) {
    for (const connection of this.connections.get(userId) || []) {
      if (connection.response.writableLength > 256 * 1024) { connection.response.destroy(); continue; }
      connection.response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  }
  chat(chatId, event) {
    for (const row of this.db.prepare('SELECT user_id FROM members WHERE chat_id=?').all(chatId)) this.send(row.user_id, event);
  }
  presence(userId) {
    for (const id of this.contacts(userId)) this.send(id, { type: 'presence', userId, online: this.online(userId) });
  }
  connect(req, res, session) {
    const id = session.user_id;
    let entries = this.connections.get(id);
    if ((entries?.size || 0) >= 6) fail(429, 'Открыто слишком много вкладок. Закройте лишние.');
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    if (!entries) { entries = new Set(); this.connections.set(id, entries); }
    const connection = { response: res, tokenHash: session.token_hash };
    entries.add(connection);
    res.write(`data: ${JSON.stringify({ type: 'ready', online: this.contacts(id).filter(x => this.online(x)) })}\n\n`);
    if (entries.size === 1) this.presence(id);
    const heartbeat = setInterval(() => {
      if (session.expires_at <= Date.now() || !this.db.prepare('SELECT 1 FROM sessions WHERE token_hash=?').get(session.token_hash)) return res.end();
      res.write(': heartbeat\n\n');
    }, 20000);
    heartbeat.unref();
    res.on('close', () => {
      clearInterval(heartbeat); entries.delete(connection);
      if (!entries.size) { this.connections.delete(id); this.presence(id); }
    });
  }
  revoke(tokenHash) {
    for (const entries of this.connections.values()) for (const connection of entries) if (connection.tokenHash === tokenHash) connection.response.end();
  }
  close() { for (const entries of this.connections.values()) for (const connection of entries) connection.response.end(); }
}
