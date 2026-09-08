// Isolated, explicitly labelled product tour. No requests to the real API, no credentials.
export function createDemo() {
  const me = { id: 'demo-me', username: 'alisa', displayName: 'Алиса Миронова', color: 'blue', bio: 'Собираю хорошие моменты' };
  const people = [me,
    { id: 'demo-max', username: 'maksim', displayName: 'Максим Волков', color: 'green', bio: 'Делаю сложное простым', online: true },
    { id: 'demo-vera', username: 'vera', displayName: 'Вера Соколова', color: 'purple', bio: 'Вижу красоту в деталях', online: true },
    { id: 'demo-nik', username: 'nikita', displayName: 'Никита Орлов', color: 'orange', bio: 'Всегда за новые маршруты', online: false },
    { id: 'demo-anna', username: 'anna', displayName: 'Анна Белова', color: 'orange', bio: 'Кофе, книги и длинные разговоры', online: false },
  ];
  const today = new Date(); today.setHours(10, 20, 0, 0); const start = today.getTime();
  let seq = 100, handler = () => {};
  const chats = [
    { id: 'demo-team', kind: 'group', title: 'Команда Messa', color: 'purple', members: people.slice(0,4), pinned: true, unread: 0 },
    { id: 'demo-saved', kind: 'saved', title: 'Избранное', color: 'blue', members: [me], pinned: true, unread: 0 },
    { id: 'demo-vera-chat', kind: 'direct', title: 'Вера Соколова', color: 'purple', members: [me,people[2]], pinned: false, unread: 2 },
    { id: 'demo-weekend', kind: 'group', title: 'Планы на выходные', color: 'green', members: people, pinned: false, unread: 3 },
    { id: 'demo-max-chat', kind: 'direct', title: 'Максим Волков', color: 'green', members: [me,people[1]], pinned: false, unread: 0 },
    { id: 'demo-anna-chat', kind: 'direct', title: 'Анна Белова', color: 'orange', members: [me,people[4]], pinned: false, unread: 0 },
  ].map(c => ({ muted: false, archived: false, updatedAt: start, ...c }));
  const messages = new Map(chats.map(c => [c.id, []]));
  function add(chatId, person, text, extra = {}) {
    const message = { id: ++seq, chatId, sender: person, clientId: crypto.randomUUID(), text, createdAt: start + (seq - 100) * 60000, reactions: [], readBy: person.id === me.id ? ['demo-max','demo-vera'] : [], ...extra };
    messages.get(chatId).push(message); return message;
  }
  add('demo-team', people[1], 'Доброе утро, команда! ☀️\nКак вам наше новое место для разговоров?');
  const first = add('demo-team', people[2], 'Здесь так спокойно. Ничего не отвлекает — только мы и наши идеи.');
  add('demo-team', me, 'Именно этого и хотелось. Меньше шума, больше настоящего общения 💙', { reactions: [{ emoji: '❤️', user_id: people[1].id }, { emoji: '❤️', user_id: people[2].id }] });
  add('demo-team', people[3], 'Тогда предлагаю начать с важного: куда идём за кофе?');
  add('demo-team', me, 'В нашу кофейню на углу? В 12:30 буду там.', { reply: { id: first.id, name: people[2].displayName, text: 'Здесь так спокойно. Ничего не отвлекает…' } });
  add('demo-team', people[2], 'Договорились. Хорошие разговоры заслуживают хорошего кофе ☕', { reactions: [{ emoji: '👍', user_id: me.id }] });
  add('demo-saved', me, 'Место для ссылок, идей и того, что не хочется потерять.');
  add('demo-vera-chat', people[2], 'Нашла очень уютное место. Давай заглянем после работы?');
  add('demo-weekend', people[3], 'А что, если в субботу уехать к морю? 🌊');
  add('demo-max-chat', people[1], 'Спасибо! Всё получилось 🙌');
  add('demo-anna-chat', people[4], 'Книгу оставила у тебя на столе. Приятного чтения!');
  const emit = event => queueMicrotask(() => handler(structuredClone(event)));
  function view(chat) {
    const last = messages.get(chat.id).at(-1);
    return { ...chat, lastMessage: last ? { text: last.deletedAt ? 'Сообщение удалено' : last.text || 'Вложение', sender: last.sender.displayName, senderId: last.sender.id, createdAt: last.createdAt } : null };
  }
  const files = new Map();
  async function request(method, route, body) {
    const url = new URL(route, 'https://demo.local'), p = url.pathname;
    const clone = data => structuredClone(data);
    if (p === '/config') return { registration: true, inviteRequired: false, maxFileBytes: 10485760 };
    if (p === '/auth/session') return { user: clone(me), csrf: 'demo-only' };
    if (p.startsWith('/auth/logout')) return { ok: true };
    if (p === '/profile') { me.displayName = body.displayName; me.bio = body.bio; return { user: clone(me) }; }
    if (p === '/users') return { users: clone(people.slice(1).filter(u => u.username.startsWith((url.searchParams.get('q') || '').toLowerCase()))) };
    if (p === '/chats' && method === 'GET') return { chats: clone(chats.map(view)) };
    if (p === '/chats' && method === 'POST') {
      const selected = people.filter(u => body.usernames.includes(u.username));
      const existing = body.kind === 'direct' && chats.find(c => c.kind === 'direct' && c.members.some(u => u.id === selected[0]?.id));
      if (existing) return { chat: clone(view(existing)) };
      const c = { id: crypto.randomUUID(), kind: body.kind, title: body.title || selected[0].displayName, members: [me,...selected], color: 'purple', pinned: false, muted: false, archived: false, unread: 0, updatedAt: Date.now() };
      chats.push(c); messages.set(c.id, []); emit({ type: 'refresh' }); return { chat: clone(view(c)) };
    }
    let match = p.match(/^\/chats\/([^/]+)(?:\/(messages|read|typing))?$/);
    if (match) {
      const chatId = match[1], action = match[2], chat = chats.find(c => c.id === chatId);
      if (!action && method === 'PATCH') { Object.assign(chat, body); emit({ type: 'refresh' }); return { chat: clone(view(chat)) }; }
      if (action === 'messages' && method === 'GET') {
        const query = (url.searchParams.get('q') || '').toLowerCase();
        const list = messages.get(chatId).filter(m => m.id < Number(url.searchParams.get('before') || 1e15) && (!query || (!m.deletedAt && m.text.toLowerCase().includes(query))));
        return { messages: clone(list.slice(-50)), hasMore: list.length > 50 };
      }
      if (action === 'messages' && method === 'POST') {
        const duplicate = messages.get(chatId).find(m => m.clientId === body.clientId);
        if (duplicate) return { message: clone(duplicate) };
        const reply = messages.get(chatId).find(m => m.id === body.replyTo);
        const message = add(chatId, me, body.text, { createdAt: Date.now(), clientId: body.clientId, readBy: [], file: files.get(body.fileId) || null, reply: reply ? { id: reply.id, name: reply.sender.displayName, text: reply.text.slice(0,160) } : null });
        chat.updatedAt = Date.now(); emit({ type: 'message', chatId, message });
        return { message: clone(message) };
      }
      if (action === 'read') { chat.unread = 0; return { ok: true }; }
      if (action === 'typing') return { ok: true };
    }
    match = p.match(/^\/messages\/(\d+)(?:\/(reactions))?$/);
    if (match) {
      const m = [...messages.values()].flat().find(m => m.id === Number(match[1]));
      if (match[2]) { const index = m.reactions.findIndex(r => r.user_id === me.id && r.emoji === body.emoji); if (index < 0) m.reactions.push({ user_id: me.id, emoji: body.emoji }); else m.reactions.splice(index,1); }
      else if (method === 'PATCH') { m.text = body.text; m.editedAt = Date.now(); }
      else { m.text = ''; m.deletedAt = Date.now(); m.file = null; m.reactions = []; }
      emit({ type: 'message.updated', chatId: m.chatId, message: m }); return { message: clone(m) };
    }
    if (p.startsWith('/files/') && method === 'DELETE') { const id = p.split('/').at(-1); const file = files.get(id); if (file?.url) URL.revokeObjectURL(file.url); files.delete(id); return { ok: true }; }
    throw new Error('Этот сценарий недоступен в демо.');
  }
  return { request, async upload(_chatId, file) { const record = { id: crypto.randomUUID(), name: file.name, size: file.size, mime: /^image\/(png|jpeg|gif|webp)$/.test(file.type) ? file.type : 'application/octet-stream', url: URL.createObjectURL(file) }; files.set(record.id, record); return { file: record }; }, subscribe(onEvent, onStatus) { handler = onEvent; onStatus('online'); queueMicrotask(() => emit({ type: 'ready', online: people.filter(u => u.online).map(u => u.id) })); return () => { handler = () => {}; }; } };
}
