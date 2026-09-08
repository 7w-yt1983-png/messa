import { createApi } from './api.js';
import { createDemo } from './demo.js';
import { icon, logo } from './icons.js';
import { esc, avatar, button, chatItem, messageItem, day, size } from './view.js';

const $ = selector => document.querySelector(selector);
const demo = new URL(location.href).searchParams.has('demo') || window.__MESSA_DEMO__ === true;
const api = demo ? createDemo() : createApi();
const state = { user: null, chats: [], activeId: null, messages: [], outbox: [], filter: 'all', reply: null, edit: null, file: null, uploading: false, search: '', hasMore: false, loading: false, historyError: '', config: {}, typing: new Map(), lastRead: new Map() };
let unsubscribe = () => {}, historyVersion = 0, chatVersion = 0, authMode = 'login', toastTimer, searchTimer, typingSent = 0, refreshTimer, peopleTimer;
const currentChat = () => state.chats.find(c => c.id === state.activeId);
const storage = {
  get(key, fallback = '') { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* Settings are optional. */ } },
  read(key, fallback) { try { return JSON.parse(sessionStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  write(key, value) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Private modes may disable draft storage. */ } },
};
const userKey = suffix => `messa:${demo ? 'demo' : state.user?.id}:${suffix}`;
for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = icon(el.dataset.icon);
for (const el of document.querySelectorAll('[data-icon-before]')) el.insertAdjacentHTML('afterbegin', icon(el.dataset.iconBefore));
for (const el of document.querySelectorAll('[data-logo]')) el.innerHTML = logo();
function setTheme(theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  storage.set('messa-theme', theme);
  $('#auth-theme').innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
}
setTheme(storage.get('messa-theme', 'system'));
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6000); }
function announce(message) { $('#announcer').textContent = message; }
function showError(selector, message) { const el = $(selector); if (el) { el.textContent = message; el.hidden = !message; } }
function showModal(title, body) {
  $('#modal-content').innerHTML = `<div class="modal-head"><h2 id="modal-title">${esc(title)}</h2>${button('close','Закрыть','close-modal')}</div><div class="modal-body">${body}<p id="modal-error" class="form-error" role="alert" hidden></p></div>`;
  $('#modal').setAttribute('aria-labelledby', 'modal-title');
  if (!$('#modal').open) $('#modal').showModal();
}
function closeModal() { $('#modal').close(); }
function setConnection(status) {
  $('#connection-text').textContent = demo ? 'Демо' : status === 'online' ? 'На связи' : 'Нет связи';
  $('#connection-dot').classList.toggle('offline', status !== 'online');
  $('#connection-banner').hidden = status === 'online' || !state.user;
}
function persistOutbox() { storage.write(userKey('outbox'), state.outbox.map(m => ({ ...m, _status: 'failed' }))); }
function saveDraft() { if (state.user && state.activeId && !state.edit) storage.write(userKey(`draft:${state.activeId}`), $('#composer-input').value); }
function clearLocalUser() {
  const prefix = userKey('');
  try { for (const key of Object.keys(sessionStorage)) if (key.startsWith(prefix)) sessionStorage.removeItem(key); } catch { /* no storage */ }
}
function goToAuth(expired = false) {
  unsubscribe(); historyVersion++; chatVersion++; closeModal();
  state.user = null; state.chats = []; state.messages = []; state.outbox = []; state.activeId = null; state.typing.clear();
  $('#app').hidden = true; $('#app').classList.remove('mobile-chat','has-inspector'); $('#inspector').hidden = true; $('#auth').hidden = false; $('#auth-form').reset(); authMode = 'login'; setAuthMode();
  $('#composer-input').value = ''; $('#messages').innerHTML = ''; $('#chat-list').innerHTML = ''; $('#inspector').innerHTML = '';
  if (expired) showError('#auth-error', 'Сессия истекла. Войдите снова — черновики останутся в этой вкладке.');
}
async function guarded(fn) { try { return await fn(); } catch (error) { if (error.status === 401 && state.user) { saveDraft(); goToAuth(true); } else if ($('#modal').open) showError('#modal-error', error.message); else toast(error.message); } }

function renderList() {
  const query = $('#chat-search').value.toLocaleLowerCase('ru').trim();
  const list = state.chats.filter(c => c.archived === (state.filter === 'archive') && (state.filter !== 'unread' || c.unread > 0) && (state.filter !== 'group' || c.kind === 'group') && c.title.toLocaleLowerCase('ru').includes(query)).sort((a,b) => Number(b.pinned)-Number(a.pinned) || b.updatedAt-a.updatedAt);
  let pinnedLabel = false, otherLabel = false;
  $('#chat-list').innerHTML = list.map(c => {
    let label = '';
    if (c.pinned && !pinnedLabel) { label = `<div class="list-label">${icon('pin')} Закреплённые</div>`; pinnedLabel = true; }
    if (!c.pinned && !otherLabel) { label = `<div class="list-label">${state.filter === 'archive' ? 'Архив' : 'Все разговоры'}</div>`; otherLabel = true; }
    return label + chatItem(c, c.id === state.activeId, state.user.id);
  }).join('') || '<p class="list-empty">Здесь пока тихо.<br />Найдите собеседника или измените фильтр.</p>';
  const unread = state.chats.reduce((n,c) => n + (!c.archived && c.unread ? 1 : 0), 0);
  $('#unread-total').textContent = unread ? String(unread) : '';
  document.title = `${unread ? `(${unread}) ` : ''}Messa — ${currentChat()?.title || 'Сообщения'}`;
  for (const el of document.querySelectorAll('[data-filter]')) { el.classList.toggle('active', el.dataset.filter === state.filter); el.setAttribute('aria-pressed', String(el.dataset.filter === state.filter)); }
}
function renderHeader() {
  const c = currentChat();
  if (!c) { $('#chat-header').innerHTML = '<div class="header-copy"><h2>Ваши сообщения</h2><p>Ближе к тем, кто важен</p></div>'; $('#composer').hidden = true; return; }
  const online = c.members.filter(u => u.id !== state.user.id && u.online).length;
  const subtitle = c.kind === 'saved' ? 'Ваше личное пространство' : c.kind === 'group' ? `${c.members.length} участников${online ? ` · ${online} в сети` : ''}` : online ? 'В сети' : 'Не в сети';
  $('#chat-header').innerHTML = `${button('arrow','К списку чатов','back')}${avatar(c)}<div class="header-copy"><h2>${esc(c.title)}</h2><p>${online ? '<span class="status-dot"></span>' : ''}${subtitle}</p></div><div class="header-actions">${button('search','Поиск сообщений','search-messages')}${button('info','Информация о чате','info')}${button('more','Настройки чата','chat-menu')}</div>`;
  $('#chat-header [data-action=back]').classList.add('back-button');
  $('#chat-header [data-action=info]').classList.add('info-button');
  $('#composer').hidden = !!state.search || !$('#message-search-bar').hidden;
  renderInspector();
}
function renderInspector() {
  if ($('#inspector').hidden) return;
  const c = currentChat(); if (!c) return;
  $('#inspector').innerHTML = `<div class="inspector-top"><span>Информация о чате</span>${button('close','Закрыть информацию','info')}</div><div class="inspector-hero">${avatar(c,true)}<h2>${esc(c.title)}</h2><p>${c.kind === 'saved' ? 'Ссылки, заметки и хорошие идеи' : c.kind === 'group' ? 'Хорошие идеи начинаются с разговора' : esc(c.members.find(u => u.id !== state.user.id)?.bio || 'Ваш личный разговор')}</p></div><button class="menu-action" data-action="toggle-pin">${icon('pin')}${c.pinned ? 'Открепить чат' : 'Закрепить чат'}</button><button class="menu-action" data-action="toggle-mute">${icon(c.muted ? 'mute' : 'bell')}${c.muted ? 'Включить уведомления' : 'Без уведомлений'}</button><div class="inspector-section"><h3>УЧАСТНИКИ · ${c.members.length}</h3>${c.members.map(u => `<div class="member-row">${avatar(u)}<div><strong>${esc(u.displayName)}${u.id === state.user.id ? ' · Вы' : ''}</strong><small>@${esc(u.username)}</small></div></div>`).join('')}</div><div class="inspector-note">${icon('shield')}<p>Ваш сервер. Ваши данные.</p><p>Сообщения хранятся на сервере. Сквозное шифрование в этой версии не реализовано.</p></div>`;
}
function nearBottom() { const box = $('#messages'); return box.scrollHeight - box.scrollTop - box.clientHeight < 100; }
function renderMessages({ bottom = false, prepend = false } = {}) {
  const box = $('#messages'), top = box.scrollTop, height = box.scrollHeight, stick = nearBottom();
  const c = currentChat();
  if (!c) { box.innerHTML = `<div class="empty-state"><div class="empty-icon">${icon('chat')}</div><h2>Разговор начинается с «привет»</h2><p>Выберите чат слева или найдите человека по имени пользователя.</p><button class="primary" data-action="new-chat">Начать разговор</button></div>`; return; }
  const list = [...state.messages, ...state.outbox.filter(m => m.chatId === c.id && !state.messages.some(x => x.clientId === m.clientId))];
  if (!list.length) {
    box.innerHTML = `<div class="empty-state"><div class="empty-icon">${icon(state.search ? 'search' : c.kind === 'saved' ? 'bookmark' : 'chat')}</div><h2>${state.historyError ? 'Не удалось загрузить историю' : state.loading ? 'Загружаем сообщения…' : state.search ? 'Ничего не найдено' : c.kind === 'saved' ? 'Важное не потеряется' : 'Самое время поздороваться'}</h2><p>${state.historyError ? esc(state.historyError) : state.search ? 'Попробуйте другое слово или более короткий запрос.' : c.kind === 'saved' ? 'Отправляйте сюда заметки, ссылки и файлы. Этот чат виден только вам.' : 'Одно сообщение — и вы уже немного ближе.'}</p>${state.historyError ? '<button class="secondary" data-action="reload-messages">Повторить загрузку</button>' : ''}</div>`;
  } else {
    let previous = '';
    box.innerHTML = `<div class="messages-inner">${state.hasMore ? '<button class="load-more" data-action="older">Загрузить предыдущие сообщения</button>' : ''}${list.map(m => { const d = day(m.createdAt), separator = d !== previous ? `<div class="date-divider"><span>${d}</span></div>` : ''; previous = d; return separator + messageItem(m,state.user.id,c.kind === 'group'); }).join('')}</div>`;
  }
  if (prepend) box.scrollTop = top + box.scrollHeight - height;
  else if (bottom || stick) box.scrollTop = box.scrollHeight;
  else box.scrollTop = top;
  $('#scroll-bottom').hidden = nearBottom();
}
function renderContext() {
  const context = state.edit || state.reply;
  $('#composer-context').hidden = !context;
  $('#composer-context').innerHTML = context ? `${icon(state.edit ? 'edit' : 'reply')}<div><strong>${state.edit ? 'Редактирование' : esc(context.sender.displayName)}</strong><span>${esc(context.text || 'Вложение')}</span></div>${button('close','Отменить','cancel-context')}` : '';
  $('#attachment-preview').hidden = !state.file && !state.uploading;
  $('#attachment-preview').innerHTML = state.uploading ? '<div><strong>Загружаем файл…</strong><span>Не закрывайте эту вкладку</span></div>' : state.file ? `${icon('file')}<div><strong>${esc(state.file.name)}</strong><span>${size(state.file.size)} · Готов к отправке</span></div>${button('close','Убрать вложение','remove-file')}` : '';
  updateComposer();
}
function updateComposer() {
  const input = $('#composer-input');
  input.style.height = '44px'; input.style.height = `${Math.min(150, input.scrollHeight)}px`;
  $('#character-count').textContent = input.value.length > 3600 ? `${input.value.length} / 4000` : '';
  $('#send-button').disabled = (!input.value.trim() && !state.file) || state.uploading;
  $('#attach-button').disabled = state.uploading || !!state.file || !!state.edit;
}
function renderTyping() {
  const now = Date.now(), names = [...state.typing.values()].filter(x => x.chatId === state.activeId && x.until > now).map(x => x.name.split(' ')[0]);
  $('#typing').textContent = names.length ? `${names.slice(0,2).join(', ')} ${names.length > 1 ? 'печатают' : 'печатает'}…` : '';
}
async function refreshChats() {
  const version = ++chatVersion, result = await api.request('GET','/chats');
  if (!state.user || version !== chatVersion) return;
  state.chats = result.chats; renderList(); renderHeader();
}
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => guarded(refreshChats), 120); }
async function loadMessages({ older = false, quiet = false } = {}) {
  const id = state.activeId; if (!id) return;
  const version = ++historyVersion;
  state.loading = true; state.historyError = ''; if (!quiet && !older) renderMessages();
  const query = new URLSearchParams();
  if (older && state.messages.length) query.set('before', state.messages[0].id);
  if (state.search) query.set('q',state.search);
  try {
    const data = await api.request('GET', `/chats/${id}/messages?${query}`);
    if (id !== state.activeId || version !== historyVersion || !state.user) return;
    const concurrent = state.messages.filter(m => m.id > (data.messages.at(-1)?.id || 0));
    state.messages = older ? [...data.messages, ...state.messages] : [...data.messages, ...concurrent.filter(m => !state.search || m.text.toLocaleLowerCase('ru').includes(state.search.toLocaleLowerCase('ru')))];
    state.messages = [...new Map(state.messages.map(m => [m.id,m])).values()].sort((a,b)=>a.id-b.id);
    state.hasMore = data.hasMore; state.loading = false;
    const confirmed = new Set(state.messages.map(m => m.clientId));
    state.outbox = state.outbox.filter(m => !confirmed.has(m.clientId)); persistOutbox();
    renderMessages({ bottom: !quiet && !older, prepend: older });
    if (!older) markRead();
  } catch (error) {
    if (version === historyVersion && id === state.activeId) { state.historyError = error.message; state.loading = false; if (!quiet || !state.messages.length) renderMessages(); }
    throw error;
  } finally { if (version === historyVersion) state.loading = false; }
}
async function selectChat(id, reveal = true) {
  if (!state.chats.some(c => c.id === id)) return;
  saveDraft(); state.activeId = id; state.messages = []; state.hasMore = false; state.reply = null; state.edit = null; state.search = ''; state.typing.clear();
  if (state.file && !demo) api.request('DELETE',`/files/${state.file.id}`).catch(() => {});
  state.file = null; state.uploading = false;
  $('#message-search-bar').hidden = true; $('#message-search').value = ''; $('#composer-input').value = storage.read(userKey(`draft:${id}`),'');
  storage.write(userKey('active'),id);
  if (reveal) $('#app').classList.add('mobile-chat');
  renderList(); renderHeader(); renderContext(); renderTyping();
  await loadMessages();
}
async function markRead() {
  if (!state.user || document.hidden || !nearBottom() || state.search || !$('#message-search-bar').hidden || !state.messages.length) return;
  // Hidden mobile conversations must not consume unread messages.
  if (getComputedStyle($('#conversation')).display === 'none') return;
  const id = state.activeId, through = state.messages.at(-1).id, previous = state.lastRead.get(id) || 0;
  if (through <= previous) return;
  state.lastRead.set(id,through);
  try { await api.request('POST',`/chats/${id}/read`,{through}); if (state.user) { const c = state.chats.find(c=>c.id===id); if(c)c.unread=0; renderList(); } }
  catch { state.lastRead.set(id,previous); }
}
function receive(event) {
  if (!state.user) return;
  if (event.type === 'session.expired') { saveDraft(); goToAuth(true); return; }
  if (event.type === 'ready') { guarded(async () => { await refreshChats(); if(state.activeId) await loadMessages({quiet:true}); }); return; }
  if (event.type === 'presence') {
    for (const c of state.chats) for (const u of c.members) if (u.id === event.userId) u.online = event.online;
    renderList(); renderHeader(); return;
  }
  if (event.type === 'typing') {
    if (event.userId === state.user.id) return;
    const person = currentChat()?.members.find(u=>u.id===event.userId);
    if (person && event.active) state.typing.set(event.userId,{name:person.displayName,chatId:event.chatId,until:Date.now()+4500}); else state.typing.delete(event.userId);
    renderTyping(); return;
  }
  if (event.type === 'read') {
    if (event.chatId === state.activeId) {
      for (const m of state.messages) if (m.id <= event.through && m.sender.id !== event.userId && !m.readBy.includes(event.userId)) m.readBy.push(event.userId);
      renderMessages();
    }
    if (event.userId === state.user.id) scheduleRefresh();
    return;
  }
  if (event.message) {
    const message = event.message;
    for (const entry of state.messages) if (entry.reply?.id === message.id) entry.reply.text = message.deletedAt ? 'Сообщение удалено' : (message.text || 'Вложение').slice(0,160);
    state.outbox = state.outbox.filter(m => m.clientId !== message.clientId); persistOutbox();
    if (event.chatId === state.activeId) {
      const index = state.messages.findIndex(m=>m.id===message.id);
      const matches = !state.search || (!message.deletedAt && message.text.toLocaleLowerCase('ru').includes(state.search.toLocaleLowerCase('ru')));
      if (index >= 0 && !matches) state.messages.splice(index,1);
      else if (index >= 0) state.messages[index] = message;
      else if(matches)state.messages.push(message);
      state.typing.delete(message.sender.id); renderMessages(); renderTyping(); markRead();
      if (event.type === 'message' && message.sender.id !== state.user.id) announce(`Новое сообщение от ${message.sender.displayName}`);
    }
    if (event.type === 'message' && message.sender.id !== state.user.id && document.hidden && storage.get('messa-notifications') === 'true' && 'Notification' in window && Notification.permission === 'granted') {
      const c = state.chats.find(c=>c.id===event.chatId);
      if(c && !c.muted) { const notice = new Notification('Messa', { body:`Новое сообщение · ${c.title}`, icon:'/icon.svg',tag:c.id }); notice.onclick=()=>{window.focus(); guarded(()=>selectChat(c.id));notice.close();}; }
    }
  }
  scheduleRefresh();
}
async function enter(user) {
  state.user = user; state.lastRead.clear(); $('#auth').hidden=true; $('#app').hidden=false; $('#demo-banner').hidden=!demo;
  $('#profile-button').innerHTML=avatar(user);
  state.outbox=storage.read(userKey('outbox'),[]).filter(m=>m.sender?.id===user.id).map(m=>({...m,_status:'failed'}));
  await refreshChats();
  const remembered=storage.read(userKey('active'),null), initial=state.chats.find(c=>c.id===remembered)?.id || state.chats.find(c=>c.kind!=='saved')?.id || state.chats[0]?.id;
  if(initial)await selectChat(initial,false);else{renderHeader();renderMessages();}
  unsubscribe();unsubscribe=api.subscribe(receive,setConnection);
  if(!demo && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
}
async function sendPending(pending) {
  pending._status='sending';persistOutbox();renderMessages({bottom:true});
  try {
    const result=await api.request('POST',`/chats/${pending.chatId}/messages`,{text:pending.text,clientId:pending.clientId,replyTo:pending.reply?.id,fileId:pending.file?.id});
    if(!state.user)return;
    state.outbox=state.outbox.filter(m=>m.clientId!==pending.clientId);persistOutbox();
    receive({type:'message.updated',chatId:pending.chatId,message:result.message});
  } catch(error) {
    const item=state.outbox.find(m=>m.clientId===pending.clientId);if(item)item._status='failed';persistOutbox();renderMessages();
    if(error.status===401){saveDraft();goToAuth(true);}else toast(error.message);
  }
}
async function submitMessage(event) {
  event.preventDefault();if(!state.user || !state.activeId || state.uploading)return;
  const input=$('#composer-input'),content=input.value.trim();if(!content&&!state.file)return;
  if(state.edit){
    const id=state.edit.id;$('#send-button').disabled=true;
    await guarded(async()=>{const result=await api.request('PATCH',`/messages/${id}`,{text:content});receive({type:'message.updated',chatId:result.message.chatId,message:result.message});state.edit=null;input.value=storage.read(userKey(`draft:${state.activeId}`),'');renderContext();});
    updateComposer();return;
  }
  const pending={id:`pending-${crypto.randomUUID()}`,chatId:state.activeId,sender:state.user,clientId:crypto.randomUUID(),text:content,createdAt:Date.now(),file:state.file,reply:state.reply?{id:state.reply.id,name:state.reply.sender.displayName,text:state.reply.text.slice(0,160)}:null,reactions:[],readBy:[],_status:'sending'};
  state.outbox.push(pending);state.file=null;state.reply=null;input.value='';saveDraft();renderContext();
  api.request('POST',`/chats/${state.activeId}/typing`,{active:false}).catch(()=>{});
  await sendPending(pending);
}

function messageMenu(id) {
  const m=state.messages.find(m=>m.id===Number(id));if(!m||m.deletedAt)return;
  showModal('Сообщение',`<div class="menu-preview">${esc(m.text||m.file?.name||'Вложение')}</div><div class="emoji-picker">${['❤️','👍','🔥','😂','🎉','🙏'].map(e=>`<button data-react="${e}" data-id="${m.id}" aria-label="Реакция ${e}">${e}</button>`).join('')}</div><button class="menu-action" data-action="reply-message" data-id="${m.id}">${icon('reply')}Ответить</button>${m.sender.id===state.user.id?`<button class="menu-action" data-action="edit-message" data-id="${m.id}">${icon('edit')}Редактировать</button><button class="menu-action danger" data-action="delete-message" data-id="${m.id}">${icon('trash')}Удалить для всех</button>`:''}`);
}
function chatMenu(){
  const c=currentChat();if(!c)return;
  showModal(c.title,`<button class="menu-action" data-action="info">${icon('info')}Информация о чате</button><button class="menu-action" data-action="toggle-pin">${icon('pin')}${c.pinned?'Открепить':'Закрепить'}</button><button class="menu-action" data-action="toggle-mute">${icon(c.muted?'bell':'mute')}${c.muted?'Включить уведомления':'Выключить уведомления'}</button><button class="menu-action" data-action="toggle-archive">${icon('archive')}${c.archived?'Вернуть из архива':'В архив'}</button>${c.kind==='group'&&c.members.find(u=>u.id===state.user.id)?.role==='owner'?`<button class="menu-action" data-action="rename-chat">${icon('edit')}Переименовать</button>`:''}`);
}
function newChat(){
  let kind='direct',selected=[],searchVersion=0;
  showModal('Новый разговор',`<div class="segmented" id="chat-kind"><button type="button" data-kind="direct" class="active">Личный чат</button><button type="button" data-kind="group">Группа</button></div><form id="new-chat-form"><label id="group-title-label" hidden>Название группы<input id="group-title" maxlength="80" placeholder="Например, наши выходные" /></label><label>Найти по имени пользователя<input id="people-search" autocomplete="off" autocapitalize="none" placeholder="Например, vera" maxlength="24" /></label><div id="selected-people" class="selected-people"></div><div id="people-results" class="people-results"><p class="settings-note">Введите минимум 2 символа имени без @.${demo?' Попробуйте vera или maksim.':''}</p></div><button type="submit" class="primary full-width" id="create-chat-button" disabled>Начать разговор</button></form>`);
  const renderSelected=()=>{ $('#selected-people').innerHTML=selected.map(u=>`<button type="button" class="person-chip" data-remove-person="${u.id}">${esc(u.displayName)} ×</button>`).join('');$('#create-chat-button').disabled=!selected.length; };
  $('#chat-kind').onclick=event=>{const b=event.target.closest('[data-kind]');if(!b)return;kind=b.dataset.kind;for(const el of $('#chat-kind').children)el.classList.toggle('active',el===b);$('#group-title-label').hidden=kind!=='group';$('#group-title').required=kind==='group';if(kind==='direct')selected=selected.slice(0,1);renderSelected();};
  $('#selected-people').onclick=event=>{const b=event.target.closest('[data-remove-person]');if(!b)return;selected=selected.filter(u=>u.id!==b.dataset.removePerson);renderSelected();};
  $('#people-search').oninput=()=>{
    const value=$('#people-search').value.trim().replace(/^@/,'');const version=++searchVersion;clearTimeout(peopleTimer);
    if(value.length<2){$('#people-results').innerHTML='<p class="settings-note">Введите минимум 2 символа.</p>';return;}
    peopleTimer=setTimeout(()=>guarded(async()=>{const result=await api.request('GET',`/users?q=${encodeURIComponent(value)}`);if(version!==searchVersion||!$('#people-results'))return;$('#people-results').innerHTML=result.users.map(u=>`<button type="button" class="user-result" data-person="${esc(u.id)}">${avatar(u)}<span><strong>${esc(u.displayName)}</strong><small>@${esc(u.username)}</small></span>${icon('plus')}</button>`).join('')||'<p class="settings-note">Никого не нашли. Проверьте имя пользователя.</p>';$('#people-results').onclick=event=>{const b=event.target.closest('[data-person]');if(!b)return;const user=result.users.find(u=>u.id===b.dataset.person);if(kind==='direct')selected=[user];else if(!selected.some(u=>u.id===user.id)&&selected.length<31)selected.push(user);renderSelected();};}),250);
  };
  $('#new-chat-form').onsubmit=event=>{event.preventDefault();guarded(async()=>{const submit=$('#create-chat-button');submit.disabled=true;try{const result=await api.request('POST','/chats',{kind,usernames:selected.map(u=>u.username),title:$('#group-title').value});closeModal();state.filter='all';await refreshChats();await selectChat(result.chat.id);}finally{if(submit.isConnected)submit.disabled=!selected.length;}});};
  $('#people-search').focus();
}
function settings(){
  const theme=storage.get('messa-theme','system');
  showModal('Ваше пространство',`<form id="profile-form"><label>Ваше имя<input name="displayName" value="${esc(state.user.displayName)}" required maxlength="50" /></label><label>О себе<textarea name="bio" maxlength="160">${esc(state.user.bio)}</textarea></label><p class="settings-note">@${esc(state.user.username)} · имя пользователя нельзя изменить</p><button class="primary full-width" type="submit">Сохранить профиль</button></form><section class="settings-section"><h3>Оформление</h3><div class="segmented">${[['system','Системное'],['light','Светлое'],['dark','Тёмное']].map(([v,t])=>`<button data-theme-choice="${v}" class="${theme===v?'active':''}">${t}</button>`).join('')}</div><button class="menu-action" data-action="notifications">${icon('bell')}${storage.get('messa-notifications')==='true'?'Выключить':'Включить'} уведомления</button><p class="settings-note">Уведомления работают, пока Messa открыта в браузере. Текст сообщений в них не показывается.</p></section><section class="settings-section"><h3>Приватность без мелкого шрифта</h3><p class="settings-note">Нет рекламы, аналитических трекеров и сторонних шрифтов. Сервер имеет доступ к сообщениям; сквозного шифрования пока нет. Черновики хранятся только в этой вкладке до выхода.</p></section><hr class="menu-separator" /><button class="menu-action danger" data-action="logout">${icon('logout')}Выйти из аккаунта</button><button class="menu-action danger" data-action="logout-all">${icon('shield')}Выйти на всех устройствах</button>`);
  $('#profile-form').onsubmit=event=>{event.preventDefault();const form=event.currentTarget;guarded(async()=>{const body=Object.fromEntries(new FormData(form));const result=await api.request('PATCH','/profile',body);state.user=result.user;$('#profile-button').innerHTML=avatar(state.user);closeModal();await refreshChats();toast('Профиль обновлён.');});};
}
async function action(name, element) {
  if(name==='close-modal')return closeModal();
  if(name==='exit-demo'){if(window.__MESSA_DEMO__)return toast('Это отдельный демо-файл. Для своего аккаунта запустите Messa из репозитория.');location.href=location.pathname;return;}
  if(!state.user)return;
  if(name==='new-chat')return newChat();
  if(name==='settings')return settings();
  if(name==='nav-chats'||name==='back'){$('#app').classList.remove('mobile-chat');state.filter='all';renderList();return;}
  if(name==='nav-saved'){const c=state.chats.find(c=>c.kind==='saved');if(c)await selectChat(c.id);return;}
  if(name==='archive'){state.filter=state.filter==='archive'?'all':'archive';renderList();return;}
  if(name==='info'){closeModal();$('#inspector').hidden=!$('#inspector').hidden;$('#app').classList.toggle('has-inspector',!$('#inspector').hidden);renderInspector();return;}
  if(name==='chat-menu')return chatMenu();
  if(name==='message-menu')return messageMenu(element.dataset.id);
  if(name==='scroll-bottom'){$('#messages').scrollTop=$('#messages').scrollHeight;markRead();return;}
  if(name==='older')return loadMessages({older:true});
  if(name==='reload-messages')return loadMessages();
  if(name==='search-messages'){$('#message-search-bar').hidden=false;$('#composer').hidden=true;$('#message-search').focus();return;}
  if(name==='close-search'){$('#message-search-bar').hidden=true;state.search='';$('#message-search').value='';renderHeader();return loadMessages();}
  if(name==='attach')return $('#file-input').click();
  if(name==='remove-file'){const file=state.file;state.file=null;renderContext();if(file)await api.request('DELETE',`/files/${file.id}`);return;}
  if(name==='emoji'){showModal('Добавить настроение',`<div class="emoji-picker">${['😊','💙','✨','👍','🎉','☕','🔥','🙏','😂','🌊','🙌','❤️'].map(e=>`<button data-insert-emoji="${e}" aria-label="Добавить ${e}">${e}</button>`).join('')}</div>`);return;}
  if(name==='cancel-context'){if(state.edit)$('#composer-input').value=storage.read(userKey(`draft:${state.activeId}`),'');state.edit=null;state.reply=null;renderContext();return;}
  if(['reply-message','edit-message'].includes(name)){
    const m=state.messages.find(m=>m.id===Number(element.dataset.id));if(!m)return;
    saveDraft();state.edit=name==='edit-message'?m:null;state.reply=name==='reply-message'?m:null;
    if(state.edit)$('#composer-input').value=m.text;
    closeModal();renderContext();$('#composer-input').focus();return;
  }
  if(name==='delete-message'){
    const id=element.dataset.id;showModal('Удалить сообщение?',`<p class="subtle">Оно исчезнет у всех участников. Это действие нельзя отменить.</p><div class="confirm-actions"><button class="secondary" data-action="close-modal">Отмена</button><button class="primary danger" id="confirm-delete">Удалить</button></div>`);
    $('#confirm-delete').onclick=()=>guarded(async()=>{const result=await api.request('DELETE',`/messages/${id}`);closeModal();receive({type:'message.updated',chatId:result.message.chatId,message:result.message});});return;
  }
  if(name.startsWith('toggle-')){
    const c=currentChat(),key={'toggle-pin':'pinned','toggle-mute':'muted','toggle-archive':'archived'}[name];if(!c||!key)return;
    await api.request('PATCH',`/chats/${c.id}`,{[key]:!c[key]});closeModal();await refreshChats();return;
  }
  if(name==='rename-chat'){
    const c=currentChat();showModal('Название группы',`<form id="rename-form"><label>Название<input name="title" value="${esc(c.title)}" required maxlength="80" /></label><button class="primary full-width">Сохранить</button></form>`);$('#rename-form').onsubmit=event=>{event.preventDefault();guarded(async()=>{await api.request('PATCH',`/chats/${c.id}`,Object.fromEntries(new FormData(event.currentTarget)));closeModal();await refreshChats();});};return;
  }
  if(name==='notifications'){
    if(!('Notification' in window)){toast('Этот браузер не поддерживает уведомления.');return;}
    if(storage.get('messa-notifications')==='true'){storage.set('messa-notifications','false');settings();return;}
    const permission=await Notification.requestPermission();storage.set('messa-notifications',String(permission==='granted'));settings();if(permission!=='granted')showError('#modal-error','Уведомления заблокированы. Их можно разрешить в настройках браузера.');return;
  }
  if(name==='logout'||name==='logout-all'){
    if(demo)return action('exit-demo',element);
    await api.request('POST',name==='logout-all'?'/auth/logout-all':'/auth/logout',{});clearLocalUser();goToAuth();return;
  }
}

// One delegated handler; dynamic content never injects event attributes or executable HTML.
document.addEventListener('click',event=>{
  const el=event.target.closest('button,[data-chat]');if(!el)return;
  if(el.dataset.chat)return guarded(()=>selectChat(el.dataset.chat));
  if(el.dataset.filter){state.filter=el.dataset.filter;renderList();return;}
  if(el.dataset.action)return guarded(()=>action(el.dataset.action,el));
  if(el.dataset.react){return guarded(async()=>{const result=await api.request('POST',`/messages/${el.dataset.id}/reactions`,{emoji:el.dataset.react});closeModal();receive({type:'message.updated',chatId:result.message.chatId,message:result.message});});}
  if(el.dataset.retry){const pending=state.outbox.find(m=>m.clientId===el.dataset.retry);if(pending&&pending._status==='failed')sendPending(pending);return;}
  if(el.dataset.themeChoice){setTheme(el.dataset.themeChoice);for(const b of document.querySelectorAll('[data-theme-choice]'))b.classList.toggle('active',b===el);return;}
  if(el.dataset.insertEmoji){const input=$('#composer-input');input.setRangeText(el.dataset.insertEmoji,input.selectionStart,input.selectionEnd,'end');closeModal();input.focus();saveDraft();updateComposer();}
});
$('#modal').addEventListener('click',event=>{if(event.target!==$('#modal'))return;const r=$('#modal').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeModal();});
$('#composer').addEventListener('submit',submitMessage);
$('#composer-input').addEventListener('input',()=>{saveDraft();updateComposer();if(state.activeId&&Date.now()-typingSent>2000){typingSent=Date.now();api.request('POST',`/chats/${state.activeId}/typing`,{active:true}).catch(()=>{});}});
$('#composer-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('#composer').requestSubmit();}});
$('#chat-search').addEventListener('input',renderList);
$('#message-search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{state.search=$('#message-search').value.trim();state.messages=[];guarded(()=>loadMessages());},250);});
$('#messages').addEventListener('scroll',()=>{$('#scroll-bottom').hidden=nearBottom();markRead();},{passive:true});
$('#file-input').addEventListener('change',()=>guarded(async()=>{
  const file=$('#file-input').files[0];$('#file-input').value='';if(!file||!state.activeId)return;
  if(file.size>state.config.maxFileBytes||file.size===0){toast('Выберите непустой файл размером до 10 МБ.');return;}
  const chatId=state.activeId;state.uploading=true;renderContext();
  try{const result=await api.upload(chatId,file);if(chatId!==state.activeId||!state.user){await api.request('DELETE',`/files/${result.file.id}`);return;}state.file=result.file;}
  finally{if(chatId===state.activeId){state.uploading=false;renderContext();}}
}));
document.addEventListener('keydown',event=>{if(!state.user)return;if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();$('#app').classList.remove('mobile-chat');$('#chat-search').focus();}if(event.key==='Escape'&&!$('#modal').open){if(!$('#inspector').hidden){$('#inspector').hidden=true;$('#app').classList.remove('has-inspector');}else if(state.reply||state.edit)guarded(()=>action('cancel-context'));}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.user){guarded(async()=>{await refreshChats();if(state.activeId)await loadMessages({quiet:true});});}});
window.addEventListener('beforeunload',saveDraft);
setInterval(renderTyping,1000);
$('#auth-theme').onclick=()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');
$('#demo-button').onclick=()=>{location.href=location.pathname+'?demo=1';};
function setAuthMode(){
  const registering=authMode==='register';$('#display-name-field').hidden=!registering;$('#display-name-field input').required=registering;$('#invite-field').hidden=!registering||!state.config.inviteRequired;
  $('#auth-title').textContent=registering?'Будем ближе':'С возвращением';$('#auth-description').textContent=registering?'Пара деталей — и можно общаться.':'Ваши разговоры ждут вас.';$('#auth-submit').textContent=registering?'Создать аккаунт':'Войти в Messa';$('#auth-switch-copy').textContent=registering?'Уже с нами?':'Впервые здесь?';$('#auth-switch').textContent=registering?'Войти':'Создать аккаунт';$('#auth-form [name=password]').autocomplete=registering?'new-password':'current-password';showError('#auth-error','');
}
$('#auth-switch').onclick=()=>{authMode=authMode==='login'?'register':'login';setAuthMode();};
$('#auth-form').onsubmit=async event=>{
  event.preventDefault();const body=Object.fromEntries(new FormData(event.currentTarget));$('#auth-submit').disabled=true;showError('#auth-error','');
  try{const result=await api.request('POST',`/auth/${authMode}`,body);$('#auth-form').reset();await enter(result.user);}catch(error){showError('#auth-error',error.message);}finally{$('#auth-submit').disabled=false;}
};
async function boot(){
  try{state.config=await api.request('GET','/config');$('.auth-switch').hidden=!state.config.registration;$('#boot-status').hidden=true;}
  catch(error){$('#boot-status').textContent=error.message+' Демо можно открыть без сервера.';}
  try{const result=await api.request('GET','/auth/session');await enter(result.user);}
  catch(error){if(error.status!==401&&!demo)$('#boot-status').textContent=error.message;}
}
boot();
