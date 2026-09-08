import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { openDatabase, transaction, publicUser } from './db.mjs';
import { EventHub } from './events.mjs';
import { HttpError, fail, token, digest, equal, hashPassword, verifyPassword, text, username, password, integer, readBody, jsonBody, cookieValue, RateLimiter, sniffImage } from './security.mjs';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const assets = { '/': 'text/html', '/index.html': 'text/html', '/styles.css': 'text/css', '/app.js': 'text/javascript', '/api.js': 'text/javascript', '/view.js': 'text/javascript', '/icons.js': 'text/javascript', '/demo.js': 'text/javascript', '/sw.js': 'text/javascript', '/icon.svg': 'image/svg+xml', '/manifest.webmanifest': 'application/manifest+json' };
const emojis = ['❤️', '👍', '🔥', '😂', '🎉', '🙏'];

export async function createApplication(config = loadConfig()) {
  const db = openDatabase(config.dataDir);
  const hub = new EventHub(db, config);
  const limiter = new RateLimiter();
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const dummyHash = await hashPassword(token());
  let hashing = 0, uploads = 0;
  const filePath = id => path.join(config.dataDir, 'uploads', id);
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  const member = (chatId, userId) => {
    const row = get('SELECT * FROM members WHERE chat_id=? AND user_id=?', chatId, userId);
    if (!row) fail(404, 'Чат не найден.');
    return row;
  };
  const sessionFor = req => {
    const value = cookieValue(req, config.cookie);
    if (!/^[a-zA-Z0-9_-]{43}$/.test(value)) fail(401, 'Войдите в аккаунт.');
    const session = get('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?', digest(value), Date.now());
    if (!session) fail(401, 'Сессия истекла. Войдите снова.');
    return session;
  };
  const setCookie = (res, value, maxAge) => res.setHeader('Set-Cookie', `${config.cookie}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.production ? '; Secure' : ''}`);
  const issueSession = (res, userId) => {
    const value = token(), csrf = token(), now = Date.now();
    const old = all('SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT -1 OFFSET 4', userId);
    for (const entry of old) { run('DELETE FROM sessions WHERE token_hash=?', entry.token_hash); hub.revoke(entry.token_hash); }
    run('INSERT INTO sessions VALUES (?,?,?,?,?)', digest(value), userId, csrf, now, now + config.sessionMs);
    setCookie(res, value, config.sessionMs / 1000);
    return { user: publicUser(get('SELECT * FROM users WHERE id=?', userId)), csrf };
  };
  const fileView = row => row && ({ id: row.id, name: row.name, mime: row.mime, size: row.size });
  const messageView = row => {
    const sender = get('SELECT * FROM users WHERE id=?', row.sender_id);
    const reply = row.reply_to && get('SELECT m.*,u.display_name FROM messages m JOIN users u ON m.sender_id=u.id WHERE m.id=?', row.reply_to);
    return {
      id: row.id, chatId: row.chat_id, sender: publicUser(sender), clientId: row.client_id,
      text: row.deleted_at ? '' : row.text, createdAt: row.created_at, editedAt: row.edited_at, deletedAt: row.deleted_at,
      file: !row.deleted_at && row.file_id ? fileView(get('SELECT * FROM files WHERE id=?', row.file_id)) : null,
      reply: reply ? { id: reply.id, name: reply.display_name, text: reply.deleted_at ? 'Сообщение удалено' : (reply.text || 'Вложение').slice(0, 160) } : null,
      reactions: row.deleted_at ? [] : all('SELECT emoji,user_id FROM reactions WHERE message_id=?', row.id),
      readBy: all('SELECT user_id FROM members WHERE chat_id=? AND user_id<>? AND last_read>=?', row.chat_id, row.sender_id, row.id).map(x => x.user_id),
    };
  };
  const chatView = (row, userId) => {
    const members = all('SELECT u.*, m.role FROM users u JOIN members m ON u.id=m.user_id WHERE m.chat_id=? ORDER BY m.role DESC,u.display_name', row.id).map(u => ({ ...publicUser(u), role: u.role, online: hub.online(u.id) }));
    const prefs = member(row.id, userId);
    const last = get('SELECT m.*,u.display_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE chat_id=? ORDER BY m.id DESC LIMIT 1', row.id);
    const other = members.find(u => u.id !== userId);
    return {
      id: row.id, kind: row.kind, title: row.kind === 'direct' ? (other?.displayName || row.title) : row.title,
      color: row.kind === 'direct' ? other?.color || 'blue' : row.kind === 'saved' ? 'blue' : 'purple',
      members, pinned: !!prefs.pinned, muted: !!prefs.muted, archived: !!prefs.archived,
      updatedAt: row.updated_at,
      unread: get('SELECT count(*) AS n FROM messages WHERE chat_id=? AND id>? AND sender_id<>? AND deleted_at IS NULL', row.id, prefs.last_read, userId).n,
      lastMessage: last ? { text: last.deleted_at ? 'Сообщение удалено' : last.text || 'Вложение', sender: last.display_name, senderId: last.sender_id, createdAt: last.created_at } : null,
    };
  };
  const ownMessage = (id, userId) => {
    const message = get('SELECT * FROM messages WHERE id=?', integer(id));
    if (!message) fail(404, 'Сообщение не найдено.');
    member(message.chat_id, userId);
    return message;
  };

  async function route(req, res) {
    const url = new URL(req.url, config.origin), p = url.pathname, method = req.method;
    if (p === '/healthz' && method === 'GET') { get('SELECT 1'); return json(res, 200, { status: 'ok' }); }
    if (!p.startsWith('/api/')) {
      if (!['GET', 'HEAD'].includes(method) || !assets[p]) fail(404, 'Страница не найдена.');
      const content = await readFile(path.join(publicDir, p === '/' ? 'index.html' : p.slice(1)));
      res.writeHead(200, { 'Content-Type': `${assets[p]}; charset=utf-8`, 'Cache-Control': 'no-cache' });
      return res.end(method === 'HEAD' ? undefined : content);
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Межсайтовый запрос отклонён.');
    if (!['GET', 'HEAD'].includes(method) && req.headers.origin !== config.origin) fail(403, 'Недопустимый источник запроса.');
    if (req.headers.origin && req.headers.origin !== config.origin) fail(403, 'Недопустимый источник запроса.');
    const ip = req.socket.remoteAddress || 'unknown'; // Do not trust spoofable X-Forwarded-For.
    limiter.take(`network:${ip}`, 1800, 60000);
    if (p === '/api/config' && method === 'GET') return json(res, 200, { registration: config.registration, inviteRequired: !!config.registrationCode, maxFileBytes: config.maxFileBytes, encryption: 'server-readable' });

    if (['/api/auth/register', '/api/auth/login'].includes(p) && method === 'POST') {
      limiter.take(`auth:${ip}`, 30, 15 * 60000);
      const body = await jsonBody(req), handle = username(body.username), secret = password(body.password);
      limiter.take(`account:${handle}`, 15, 15 * 60000);
      if (hashing >= 4) fail(503, 'Сервер занят. Попробуйте через несколько секунд.');
      hashing++;
      try {
        if (p.endsWith('register')) {
          if (!config.registration) fail(403, 'Регистрация закрыта администратором.');
          if (config.registrationCode && !equal(body.inviteCode, config.registrationCode)) fail(403, 'Неверный код приглашения.');
          const name = text(body.displayName, 'Имя', 1, 50);
          const hash = await hashPassword(secret), id = randomUUID(), now = Date.now();
          transaction(db, () => {
            if (get('SELECT 1 FROM users WHERE username=?', handle)) fail(409, 'Это имя пользователя недоступно.');
            run('INSERT INTO users (id,username,display_name,password_hash,color,created_at) VALUES (?,?,?,?,?,?)', id, handle, name, hash, ['blue','purple','orange','green'][Math.floor(Math.random()*4)], now);
            const saved = randomUUID();
            run('INSERT INTO chats VALUES (?,?,?,?,?,?,?)', saved, 'saved', 'Избранное', id, `saved:${id}`, now, now);
            run('INSERT INTO members (chat_id,user_id,role,pinned) VALUES (?,?,?,1)', saved, id, 'owner');
          });
          return json(res, 201, issueSession(res, id));
        }
        const user = get('SELECT * FROM users WHERE username=?', handle);
        const valid = await verifyPassword(secret, user?.password_hash || dummyHash);
        if (!valid || !user) fail(401, 'Неверное имя пользователя или пароль.');
        return json(res, 200, issueSession(res, user.id));
      } finally { hashing--; }
    }

    const session = sessionFor(req), userId = session.user_id;
    if (!['GET', 'HEAD'].includes(method) && !equal(req.headers['x-csrf-token'], session.csrf)) fail(403, 'Защитный токен устарел. Обновите страницу.');
    limiter.take(`user:${userId}`, 600, 60000);
    if (p === '/api/auth/session' && method === 'GET') return json(res, 200, { user: publicUser(get('SELECT * FROM users WHERE id=?', userId)), csrf: session.csrf });
    if (p === '/api/auth/logout' && method === 'POST') {
      run('DELETE FROM sessions WHERE token_hash=?', session.token_hash); hub.revoke(session.token_hash); setCookie(res, '', 0);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/auth/logout-all' && method === 'POST') {
      for (const row of all('SELECT token_hash FROM sessions WHERE user_id=?', userId)) hub.revoke(row.token_hash);
      run('DELETE FROM sessions WHERE user_id=?', userId); setCookie(res, '', 0); return json(res, 200, { ok: true });
    }
    if (p === '/api/events' && method === 'GET') return hub.connect(req, res, session);
    if (p === '/api/profile' && method === 'PATCH') {
      const body = await jsonBody(req), name = text(body.displayName, 'Имя', 1, 50), bio = text(body.bio ?? '', 'О себе', 0, 160);
      run('UPDATE users SET display_name=?,bio=? WHERE id=?', name, bio, userId);
      for (const id of hub.contacts(userId)) hub.send(id, { type: 'refresh' });
      return json(res, 200, { user: publicUser(get('SELECT * FROM users WHERE id=?', userId)) });
    }
    if (p === '/api/users' && method === 'GET') {
      const query = text(url.searchParams.get('q') || '', 'Поиск', 2, 24).toLowerCase();
      const users = all('SELECT * FROM users WHERE id<>? AND instr(unicode_lower(username),?)=1 ORDER BY username LIMIT 20', userId, query).map(publicUser);
      return json(res, 200, { users });
    }
    if (p === '/api/chats' && method === 'GET') {
      const chats = all('SELECT c.* FROM chats c JOIN members m ON c.id=m.chat_id WHERE m.user_id=? ORDER BY m.pinned DESC,c.updated_at DESC', userId).map(row => chatView(row, userId));
      return json(res, 200, { chats });
    }
    if (p === '/api/chats' && method === 'POST') {
      limiter.take(`create-chat:${userId}`, 30, 60000);
      const body = await jsonBody(req);
      if (!['direct','group'].includes(body.kind) || !Array.isArray(body.usernames) || body.usernames.length < 1 || body.usernames.length > 31) fail(400, 'Выберите от 1 до 31 собеседника.');
      const handles = [...new Set(body.usernames.map(username))];
      const people = handles.map(handle => { const user = get('SELECT * FROM users WHERE username=?', handle); if (!user || user.id === userId) fail(400, 'Собеседник не найден.'); return user; });
      if (body.kind === 'direct' && people.length !== 1) fail(400, 'Выберите одного собеседника.');
      const key = body.kind === 'direct' ? [userId, people[0].id].sort().join(':') : null;
      const existing = key && get('SELECT * FROM chats WHERE direct_key=?', key);
      if (existing) { run('UPDATE members SET archived=0 WHERE chat_id=? AND user_id=?', existing.id, userId); return json(res, 200, { chat: chatView(existing, userId) }); }
      const title = body.kind === 'group' ? text(body.title, 'Название группы', 1, 80) : '';
      const id = randomUUID(), now = Date.now();
      transaction(db, () => {
        for (const uid of [userId, ...people.map(x => x.id)]) if (get('SELECT count(*) AS n FROM members WHERE user_id=?', uid).n >= 200) fail(409, 'Достигнут лимит 200 чатов у одного из участников.');
        run('INSERT INTO chats VALUES (?,?,?,?,?,?,?)', id, body.kind, title, userId, key, now, now);
        for (const uid of [userId, ...people.map(x => x.id)]) run('INSERT INTO members (chat_id,user_id,role) VALUES (?,?,?)', id, uid, uid === userId ? 'owner' : 'member');
      });
      hub.chat(id, { type: 'refresh', chatId: id });
      return json(res, 201, { chat: chatView(get('SELECT * FROM chats WHERE id=?', id), userId) });
    }

    let match = p.match(/^\/api\/chats\/([^/]+)(?:\/(messages|read|typing|files))?$/);
    if (match) {
      const [, chatId, action] = match;
      const membership = member(chatId, userId);
      if (!action && method === 'PATCH') {
        const body = await jsonBody(req);
        for (const key of ['pinned','muted','archived']) if (key in body) {
          if (typeof body[key] !== 'boolean') fail(400, 'Ожидается логическое значение.');
        }
        if ('title' in body) {
          const chat = get('SELECT * FROM chats WHERE id=?', chatId);
          if (membership.role !== 'owner' || chat.kind !== 'group') fail(403, 'Название может менять создатель группы.');
          run('UPDATE chats SET title=? WHERE id=?', text(body.title, 'Название', 1, 80), chatId);
        }
        for (const key of ['pinned','muted','archived']) if (key in body) run(`UPDATE members SET ${key}=? WHERE chat_id=? AND user_id=?`, Number(body[key]), chatId, userId);
        hub.chat(chatId, { type: 'refresh', chatId });
        return json(res, 200, { chat: chatView(get('SELECT * FROM chats WHERE id=?', chatId), userId) });
      }
      if (action === 'messages' && method === 'GET') {
        const before = integer(url.searchParams.get('before'), Number.MAX_SAFE_INTEGER);
        const limit = integer(url.searchParams.get('limit'), 50, 1, 100);
        const query = text(url.searchParams.get('q') || '', 'Поиск', 0, 100);
        const rows = all(`SELECT * FROM messages WHERE chat_id=? AND id<? ${query ? 'AND deleted_at IS NULL AND instr(unicode_lower(text),unicode_lower(?))>0' : ''} ORDER BY id DESC LIMIT ?`, ...[chatId, before, ...(query ? [query] : []), limit + 1]);
        return json(res, 200, { messages: rows.slice(0, limit).reverse().map(messageView), hasMore: rows.length > limit });
      }
      if (action === 'messages' && method === 'POST') {
        limiter.take(`send:${userId}`, 90, 60000);
        const body = await jsonBody(req), content = text(body.text ?? '', 'Сообщение', 0, 4000);
        if (typeof body.clientId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(body.clientId)) fail(400, 'Некорректный ключ сообщения.');
        const duplicate = get('SELECT * FROM messages WHERE sender_id=? AND client_id=?', userId, body.clientId);
        if (duplicate) {
          if (duplicate.chat_id !== chatId) fail(409, 'Ключ уже использован в другом чате.');
          return json(res, 200, { message: messageView(duplicate) });
        }
        const fileId = body.fileId || null;
        if (fileId) {
          if (typeof fileId !== 'string' || !get('SELECT 1 FROM files WHERE id=? AND chat_id=? AND uploader_id=?', fileId, chatId, userId)) fail(400, 'Вложение недоступно.');
          if (get('SELECT 1 FROM messages WHERE file_id=?', fileId)) fail(409, 'Вложение уже отправлено.');
        }
        if (!content && !fileId) fail(400, 'Напишите сообщение или прикрепите файл.');
        const replyTo = body.replyTo ? integer(body.replyTo) : null;
        if (replyTo && !get('SELECT 1 FROM messages WHERE id=? AND chat_id=? AND deleted_at IS NULL', replyTo, chatId)) fail(400, 'Сообщение для ответа недоступно.');
        const now = Date.now();
        const result = transaction(db, () => {
          const inserted = run('INSERT INTO messages (chat_id,sender_id,client_id,text,reply_to,file_id,created_at) VALUES (?,?,?,?,?,?,?)', chatId, userId, body.clientId, content, replyTo, fileId, now);
          run('UPDATE chats SET updated_at=? WHERE id=?', now, chatId);
          run('UPDATE members SET archived=0 WHERE chat_id=?', chatId);
          return Number(inserted.lastInsertRowid);
        });
        const message = messageView(get('SELECT * FROM messages WHERE id=?', result));
        hub.chat(chatId, { type: 'message', chatId, message });
        return json(res, 201, { message });
      }
      if (action === 'read' && method === 'POST') {
        const body = await jsonBody(req), through = integer(body.through, 0, 0);
        if (through && !get('SELECT 1 FROM messages WHERE id=? AND chat_id=?', through, chatId)) fail(400, 'Некорректная отметка прочтения.');
        if (through > membership.last_read) {
          run('UPDATE members SET last_read=? WHERE chat_id=? AND user_id=?', through, chatId, userId);
          hub.chat(chatId, { type: 'read', chatId, userId, through });
        }
        return json(res, 200, { ok: true });
      }
      if (action === 'typing' && method === 'POST') {
        limiter.take(`typing:${userId}`, 120, 60000);
        const body = await jsonBody(req);
        hub.chat(chatId, { type: 'typing', chatId, userId, active: body.active === true });
        return json(res, 200, { ok: true });
      }
      if (action === 'files' && method === 'POST') {
        limiter.take(`upload:${userId}`, 20, 60000);
        if (uploads >= 4) fail(503, 'Загрузки заняты. Повторите чуть позже.');
        let name;
        try { name = decodeURIComponent(req.headers['x-file-name'] || ''); } catch { fail(400, 'Некорректное имя файла.'); }
        name = text(name, 'Имя файла', 1, 180).replace(/[\x00-\x1f\x7f\\/]/g, '_');
        uploads++;
        try {
          const bytes = await readBody(req, config.maxFileBytes);
          if (!bytes.length) fail(400, 'Файл пустой.');
          const total = get('SELECT coalesce(sum(size),0) AS n FROM files').n;
          const userTotal = get('SELECT coalesce(sum(size),0) AS n FROM files WHERE uploader_id=?', userId).n;
          if (total + bytes.length > config.totalQuota || userTotal + bytes.length > config.userQuota) fail(413, 'Лимит хранилища исчерпан.');
          const id = randomUUID(), mime = sniffImage(bytes);
          // Reserve quota synchronously before awaiting the filesystem.
          run('INSERT INTO files VALUES (?,?,?,?,?,?,?)', id, chatId, userId, name, mime, bytes.length, Date.now());
          try { await writeFile(filePath(id), bytes, { flag: 'wx', mode: 0o600 }); }
          catch (error) { run('DELETE FROM files WHERE id=?', id); throw error; }
          return json(res, 201, { file: { id, name, mime, size: bytes.length } });
        } finally { uploads--; }
      }
    }
    match = p.match(/^\/api\/messages\/(\d+)(?:\/(reactions))?$/);
    if (match) {
      const message = ownMessage(match[1], userId), chatId = message.chat_id;
      if (match[2] === 'reactions' && method === 'POST') {
        if (message.deleted_at) fail(409, 'Сообщение удалено.');
        const body = await jsonBody(req);
        if (!emojis.includes(body.emoji)) fail(400, 'Эта реакция не поддерживается.');
        const found = get('SELECT 1 FROM reactions WHERE message_id=? AND user_id=? AND emoji=?', message.id, userId, body.emoji);
        if (found) run('DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?', message.id, userId, body.emoji);
        else run('INSERT INTO reactions VALUES (?,?,?)', message.id, userId, body.emoji);
      } else if (!match[2] && ['PATCH','DELETE'].includes(method)) {
        if (message.sender_id !== userId) fail(403, 'Можно изменять только свои сообщения.');
        if (message.deleted_at) fail(409, 'Сообщение уже удалено.');
        if (method === 'PATCH') {
          const body = await jsonBody(req), content = text(body.text, 'Сообщение', message.file_id ? 0 : 1, 4000);
          run('UPDATE messages SET text=?,edited_at=? WHERE id=?', content, Date.now(), message.id);
        } else {
          transaction(db, () => {
            run('UPDATE messages SET text=\'\',file_id=NULL,deleted_at=? WHERE id=?', Date.now(), message.id);
            run('DELETE FROM reactions WHERE message_id=?', message.id);
            if (message.file_id) run('DELETE FROM files WHERE id=?', message.file_id);
          });
          if (message.file_id) await unlink(filePath(message.file_id)).catch(() => {});
        }
      } else fail(405, 'Метод не поддерживается.');
      const updated = messageView(get('SELECT * FROM messages WHERE id=?', message.id));
      hub.chat(chatId, { type: 'message.updated', chatId, message: updated });
      return json(res, 200, { message: updated });
    }
    match = p.match(/^\/api\/files\/([a-f0-9-]{36})$/);
    if (match) {
      const file = get('SELECT * FROM files WHERE id=?', match[1]);
      if (!file) fail(404, 'Файл не найден.');
      member(file.chat_id, userId);
      const linked = get('SELECT 1 FROM messages WHERE file_id=? AND deleted_at IS NULL', file.id);
      if (!linked && file.uploader_id !== userId) fail(404, 'Файл не найден.');
      if (method === 'DELETE') {
        if (file.uploader_id !== userId || linked) fail(403, 'Удалите сообщение с этим файлом.');
        run('DELETE FROM files WHERE id=?', file.id); await unlink(filePath(file.id)).catch(() => {});
        return json(res, 200, { ok: true });
      }
      if (method === 'GET') {
        const content = await readFile(filePath(file.id));
        const inline = url.searchParams.get('inline') === '1' && file.mime.startsWith('image/');
        res.writeHead(200, { 'Content-Type': inline ? file.mime : 'application/octet-stream', 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, '%27')}`, 'Content-Length': content.length, 'Content-Security-Policy': "sandbox; default-src 'none'" });
        return res.end(content);
      }
    }
    fail(404, 'Адрес не найден.');
  }

  const server = createServer({ requestTimeout: 30000, headersTimeout: 10000, maxHeaderSize: 16384 }, (req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; worker-src 'self'");
    if (config.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    route(req, res).catch(error => {
      if (res.headersSent) return res.destroy();
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(JSON.stringify({ level: 'error', requestId, name: error.name, code: error.code || 'internal' }));
      if (status === 429) res.setHeader('Retry-After', '60');
      json(res, status, { error: status === 500 ? 'Ошибка сервера. Попробуйте ещё раз.' : error.message, requestId });
    });
  });
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  const maintenance = setInterval(() => {
    limiter.prune(); run('DELETE FROM sessions WHERE expires_at<=?', Date.now());
    const stale = all('SELECT f.id FROM files f WHERE f.created_at<? AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.file_id=f.id)', Date.now() - 86400000);
    for (const file of stale) { run('DELETE FROM files WHERE id=?', file.id); unlink(filePath(file.id)).catch(() => {}); }
  }, 60000);
  maintenance.unref();
  return { server, db, config, hub, async close() {
    clearInterval(maintenance); hub.close();
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
    db.close();
  } };
}
