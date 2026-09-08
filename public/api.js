export function createApi() {
  let csrf = '';
  async function request(method, path, body, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const headers = { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(!['GET','HEAD'].includes(method) ? { 'X-CSRF-Token': csrf } : {}), ...options.headers };
      const response = await fetch('/api' + path, { method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers, ...(body !== undefined ? { body: options.raw ? body : JSON.stringify(body) } : {}) });
      let data;
      try { data = await response.json(); } catch { throw new Error('Сервер вернул неожиданный ответ.'); }
      if (!response.ok) { const error = new Error(data.error || 'Не удалось выполнить запрос.'); error.status = response.status; throw error; }
      if (data.csrf) csrf = data.csrf;
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Сервер не ответил вовремя. Повторите запрос.');
      if (error instanceof TypeError) throw new Error('Нет связи с сервером. Проверьте подключение.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  return {
    request,
    upload: (chatId, file) => request('POST', `/chats/${chatId}/files`, file, { raw: true, headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) } }),
    subscribe(onEvent, onStatus) {
      const stream = new EventSource('/api/events');
      let checking = false;
      stream.onopen = () => onStatus('online');
      stream.onmessage = event => { try { onEvent(JSON.parse(event.data)); } catch (error) { console.error('Invalid realtime event', error.name); } };
      stream.onerror = async () => {
        onStatus('offline');
        if (checking) return;
        checking = true;
        try { await request('GET', '/auth/session'); }
        catch (error) { if (error.status === 401) { stream.close(); onEvent({ type: 'session.expired' }); } }
        finally { checking = false; }
      };
      return () => stream.close();
    },
  };
}
