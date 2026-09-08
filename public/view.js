import { icon } from './icons.js';

export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const time = value => new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(value);
export const day = value => new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long' }).format(value);
export const initials = value => String(value).trim().split(/\s+/).slice(0, 2).map(x => [...x][0] || '').join('').toUpperCase();
export const size = value => value < 1024 * 1024 ? `${Math.max(1, Math.round(value / 1024))} КБ` : `${(value / 1024 / 1024).toFixed(1)} МБ`;
export function avatar(entity, large = false) {
  const color = ['blue','purple','orange','green'].includes(entity.color) ? entity.color : 'blue';
  const symbol = entity.kind === 'saved' ? icon('bookmark') : entity.kind === 'group' ? icon('users') : esc(initials(entity.displayName || entity.title));
  return `<span class="avatar avatar-${color}${large ? ' avatar-large' : ''}" aria-hidden="true">${symbol}${entity.online ? '<span class="online-dot"></span>' : ''}</span>`;
}
export const button = (name, label, action, attrs = '') => `<button class="icon-button" type="button" data-action="${action}" aria-label="${esc(label)}" title="${esc(label)}" ${attrs}>${icon(name)}</button>`;
export function chatItem(chat, active, userId) {
  const last = chat.lastMessage;
  return `<button type="button" class="chat-item${active ? ' active' : ''}" data-chat="${esc(chat.id)}" ${active ? 'aria-current="true"' : ''}>
    ${avatar({ ...chat, online: chat.kind === 'direct' && chat.members.some(u => u.id !== userId && u.online) })}
    <span class="chat-copy"><span class="chat-title">${esc(chat.title)}${chat.muted ? icon('mute') : ''}</span><span class="chat-preview">${esc(last ? `${last.senderId === userId ? 'Вы: ' : chat.kind === 'group' ? last.sender.split(' ')[0] + ': ' : ''}${last.text}` : chat.kind === 'saved' ? 'Всё важное — под рукой' : 'Начните разговор')}</span></span>
    <span class="chat-meta">${last ? `<time>${time(last.createdAt)}</time>` : ''}${chat.unread ? `<span class="unread-count" aria-label="${chat.unread} непрочитанных">${chat.unread > 99 ? '99+' : chat.unread}</span>` : chat.pinned ? icon('pin') : ''}</span>
  </button>`;
}
function linkedText(value) {
  return String(value).split(/(https?:\/\/[^\s<>]+)/g).map(part => {
    if (!/^https?:\/\//.test(part)) return esc(part);
    try { const url = new URL(part); return `<a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(part)}</a>`; } catch { return esc(part); }
  }).join('');
}
export function messageItem(message, userId, group) {
  const own = message.sender.id === userId, deleted = !!message.deletedAt;
  const reactions = new Map();
  for (const reaction of message.reactions || []) { const entry = reactions.get(reaction.emoji) || { count: 0, mine: false }; entry.count++; entry.mine ||= reaction.user_id === userId; reactions.set(reaction.emoji, entry); }
  const file = message.file;
  const url = file?.url || (file ? `/api/files/${encodeURIComponent(file.id)}` : '');
  return `<article class="message ${own ? 'own' : 'incoming'}${message._status ? ' pending' : ''}" data-message-id="${esc(message.id)}">
    ${!own && group ? avatar(message.sender) : ''}
    <div class="message-column">${!own && group ? `<span class="message-author">${esc(message.sender.displayName)}</span>` : ''}
      <div class="message-bubble${deleted ? ' deleted' : ''}">
        ${message.reply && !deleted ? `<div class="reply-quote"><strong>${esc(message.reply.name)}</strong><span>${esc(message.reply.text)}</span></div>` : ''}
        ${file ? `${file.mime.startsWith('image/') ? `<a href="${esc(url)}" target="_blank" rel="noopener" aria-label="Открыть изображение ${esc(file.name)}"><img class="message-image" src="${esc(file.url || url + '?inline=1')}" alt="${esc(file.name)}" loading="lazy" /></a>` : ''}<a class="file-card" href="${esc(url)}" download="${esc(file.name)}">${icon('file')}<span><strong>${esc(file.name)}</strong><small>${size(file.size)} · Скачать</small></span>${icon('download')}</a>` : ''}
        ${(message.text || deleted) ? `<p class="message-text">${deleted ? 'Сообщение удалено' : linkedText(message.text)}</p>` : ''}
        <span class="message-meta">${message.editedAt && !deleted ? '<span>изменено</span>' : ''}<time datetime="${new Date(message.createdAt).toISOString()}">${time(message.createdAt)}</time>${own ? `<span class="receipt${message.readBy?.length ? ' read' : ''}" title="${message._status === 'failed' ? 'Не отправлено' : message._status ? 'Отправляется' : message.readBy?.length ? 'Прочитано' : 'Сохранено на сервере'}">${message._status ? (message._status === 'failed' ? '!' : '◷') : icon(message.readBy?.length ? 'double' : 'check')}</span>` : ''}</span>
      </div>
      ${reactions.size ? `<div class="reactions">${[...reactions].map(([emoji, entry]) => `<button type="button" class="reaction${entry.mine ? ' selected' : ''}" data-react="${esc(emoji)}" data-id="${message.id}" aria-label="Реакция ${esc(emoji)}, ${entry.count}" aria-pressed="${entry.mine}">${emoji} <span>${entry.count}</span></button>`).join('')}</div>` : ''}
      ${message._status === 'failed' ? `<button class="retry-button" data-retry="${esc(message.clientId)}">Не отправлено · Повторить</button>` : ''}
    </div>${!deleted && !message._status ? button('more', 'Действия с сообщением', 'message-menu', `data-id="${message.id}"`) : ''}
  </article>`;
}
