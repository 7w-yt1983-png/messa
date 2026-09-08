import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../server/app.mjs';
import { loadConfig } from '../server/config.mjs';

const PASS='test passphrase 2026!';
test('real HTTP integration and authorization boundaries',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'messa-test-'));
  let app=await createApplication({...loadConfig({}),dataDir:dir,port:0});
  const start=async()=>{await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));app.config.origin=`http://127.0.0.1:${app.server.address().port}`;};
  await start();
  const request=async(method,route,body,actor,extra={})=>{
    const response=await fetch(app.config.origin+route,{method,headers:{...(method!=='GET'?{'Origin':app.config.origin}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...(actor?{'Cookie':actor.cookie,'X-CSRF-Token':actor.csrf}:{}),...extra.headers},...(body!==undefined?{body:extra.raw?body:JSON.stringify(body)}:{})});
    const result=response.headers.get('content-type')?.includes('application/json')?await response.json():await response.text();
    return {status:response.status,data:result,headers:response.headers};
  };
  const register=async handle=>{const r=await request('POST','/api/auth/register',{username:handle,displayName:handle,password:PASS});assert.equal(r.status,201,JSON.stringify(r.data));return {...r.data,cookie:r.headers.get('set-cookie').split(';')[0]};};
  const alice=await register('alice_test'),bob=await register('bob_test'),outsider=await register('outsider_test');
  let chat,saved,message,file;
  try{
    await t.test('sessions use HttpOnly SameSite cookies, never plaintext tokens in SQLite',async()=>{
      const r=await request('POST','/api/auth/login',{username:'alice_test',password:PASS});assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
      const rows=app.db.prepare('SELECT * FROM sessions').all();assert(rows.every(s=>s.token_hash.length===64&&!s.token_hash.includes(alice.cookie.split('=')[1])));
      assert(!JSON.stringify(app.db.prepare('SELECT * FROM users').all()).includes(PASS));
    });
    await t.test('anonymous requests cannot enumerate chats or users',async()=>{assert.equal((await request('GET','/api/chats')).status,401);assert.equal((await request('GET','/api/users?q=al')).status,401);});
    await t.test('wrong usernames and passwords share a generic login error',async()=>{
      const a=await request('POST','/api/auth/login',{username:'missing_test',password:PASS});const b=await request('POST','/api/auth/login',{username:'alice_test',password:'wrong passphrase 123'});assert.equal(a.status,401);assert.equal(b.status,401);assert.equal(a.data.error,b.data.error);
    });
    await t.test('duplicate registration is rejected without changing the account',async()=>{assert.equal((await request('POST','/api/auth/register',{username:'alice_test',displayName:'attacker',password:PASS})).status,409);});
    await t.test('CSRF and exact Origin are enforced for all mutations',async()=>{
      const body={displayName:'changed',bio:''};assert.equal((await request('PATCH','/api/profile',body,alice,{headers:{Origin:'https://evil.example'}})).status,403);assert.equal((await request('PATCH','/api/profile',body,alice,{headers:{'X-CSRF-Token':''}})).status,403);
      assert.equal((await request('POST','/api/auth/login',{username:'alice_test',password:PASS},null,{headers:{Origin:'https://evil.example'}})).status,403);
    });
    await t.test('saved messages are private and automatic',async()=>{
      const r=await request('GET','/api/chats',undefined,alice);saved=r.data.chats.find(c=>c.kind==='saved');assert(saved);assert.equal(saved.members.length,1);assert.equal((await request('GET',`/api/chats/${saved.id}/messages`,undefined,bob)).status,404);
    });
    await t.test('direct conversations are unique regardless of creator order',async()=>{
      const r=await request('POST','/api/chats',{kind:'direct',usernames:['bob_test']},alice);assert.equal(r.status,201);chat=r.data.chat;
      const again=await request('POST','/api/chats',{kind:'direct',usernames:['alice_test']},bob);assert.equal(again.data.chat.id,chat.id);assert.equal(chat.members.length,2);
    });
    await t.test('outsiders cannot read, send, mark read, type or upload in another chat',async()=>{
      for(const [method,suffix,body] of [['GET','messages'],['POST','messages',{text:'attack',clientId:randomUUID()}],['POST','read',{through:0}],['POST','typing',{active:true}],['POST','files',{}]]) assert.equal((await request(method,`/api/chats/${chat.id}/${suffix}`,body,outsider)).status,404);
    });
    await t.test('simultaneous retries produce exactly one durable message',async()=>{
      const body={text:'Привет МИР',clientId:randomUUID()};const results=await Promise.all([request('POST',`/api/chats/${chat.id}/messages`,body,alice),request('POST',`/api/chats/${chat.id}/messages`,body,alice)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);assert.equal(results[0].data.message.id,results[1].data.message.id);message=results[0].data.message;
      assert.equal(app.db.prepare('SELECT count(*) n FROM messages WHERE client_id=?').get(body.clientId).n,1);
      assert.equal((await request('POST',`/api/chats/${saved.id}/messages`,body,alice)).status,409);
    });
    await t.test('empty and oversized messages are rejected',async()=>{
      for(const content of ['','  ','x'.repeat(4001)])assert.equal((await request('POST',`/api/chats/${chat.id}/messages`,{text:content,clientId:randomUUID()},alice)).status,400);
    });
    await t.test('Unicode search is case-insensitive and scoped to membership',async()=>{
      const r=await request('GET',`/api/chats/${chat.id}/messages?q=${encodeURIComponent('привет мир')}`,undefined,bob);assert.equal(r.data.messages.length,1);assert.equal(r.data.messages[0].id,message.id);
      const injection=await request('GET',`/api/chats/${chat.id}/messages?q=${encodeURIComponent("' OR 1=1 --")}`,undefined,bob);assert.equal(injection.data.messages.length,0);
    });
    await t.test('read cursors move forward only; receipts reflect the recipient',async()=>{
      let r=await request('GET','/api/chats',undefined,bob);assert.equal(r.data.chats.find(c=>c.id===chat.id).unread,1);
      await request('POST',`/api/chats/${chat.id}/read`,{through:message.id},bob);await request('POST',`/api/chats/${chat.id}/read`,{through:0},bob);
      r=await request('GET',`/api/chats/${chat.id}/messages`,undefined,alice);assert(r.data.messages[0].readBy.includes(bob.user.id));assert.equal(app.db.prepare('SELECT last_read FROM members WHERE chat_id=? AND user_id=?').get(chat.id,bob.user.id).last_read,message.id);
    });
    await t.test('messages cannot reply across conversations',async()=>{
      assert.equal((await request('POST',`/api/chats/${saved.id}/messages`,{text:'cross-chat reply',clientId:randomUUID(),replyTo:message.id},alice)).status,400);
    });
    await t.test('only authors can edit or delete; reaction toggles are per person',async()=>{
      assert.equal((await request('PATCH',`/api/messages/${message.id}`,{text:'attack'},bob)).status,403);assert.equal((await request('DELETE',`/api/messages/${message.id}`,undefined,bob)).status,403);
      let r=await request('PATCH',`/api/messages/${message.id}`,{text:'Привет, обновлённый мир!'},alice);assert.equal(r.status,200);assert(r.data.message.editedAt);
      r=await request('POST',`/api/messages/${message.id}/reactions`,{emoji:'❤️'},bob);assert.equal(r.data.message.reactions.length,1);
      r=await request('POST',`/api/messages/${message.id}/reactions`,{emoji:'❤️'},bob);assert.equal(r.data.message.reactions.length,0);
      assert.equal((await request('POST',`/api/messages/${message.id}/reactions`,{emoji:'<script>'},bob)).status,400);
    });
    await t.test('files are bounded, MIME-sniffed and private before sending',async()=>{
      const r=await request('POST',`/api/chats/${chat.id}/files`,Buffer.from('<svg onload="alert(1)">'),alice,{raw:true,headers:{'Content-Type':'image/svg+xml','X-File-Name':encodeURIComponent('пример.svg')}});assert.equal(r.status,201);file=r.data.file;assert.equal(file.mime,'application/octet-stream');
      assert.equal((await request('GET',`/api/files/${file.id}`,undefined,bob)).status,404);assert.equal((await request('GET',`/api/files/${file.id}`,undefined,outsider)).status,404);
      const previous=app.config.maxFileBytes;app.config.maxFileBytes=16;
      assert.equal((await request('POST',`/api/chats/${chat.id}/files`,Buffer.alloc(20),alice,{raw:true,headers:{'Content-Type':'application/octet-stream','X-File-Name':'large.bin'}})).status,413);app.config.maxFileBytes=previous;
    });
    await t.test('attachments can be sent only by their uploader, in the same chat, once',async()=>{
      assert.equal((await request('POST',`/api/chats/${chat.id}/messages`,{text:'steal',clientId:randomUUID(),fileId:file.id},bob)).status,400);
      const r=await request('POST',`/api/chats/${chat.id}/messages`,{text:'',clientId:randomUUID(),fileId:file.id},alice);assert.equal(r.status,201);file.messageId=r.data.message.id;
      assert.equal((await request('POST',`/api/chats/${chat.id}/messages`,{text:'again',clientId:randomUUID(),fileId:file.id},alice)).status,409);
      const download=await request('GET',`/api/files/${file.id}?inline=1`,undefined,bob);assert.equal(download.status,200);assert.match(download.headers.get('content-type'),/octet-stream/);assert.match(download.headers.get('content-disposition'),/^attachment/);assert.equal((await request('GET',`/api/files/${file.id}`,undefined,outsider)).status,404);
    });
    await t.test('deleted messages become tombstones and attached files are removed',async()=>{
      const r=await request('DELETE',`/api/messages/${file.messageId}`,undefined,alice);assert(r.data.message.deletedAt);assert.equal(r.data.message.text,'');assert.equal(r.data.message.file,null);assert.equal((await request('GET',`/api/files/${file.id}`,undefined,alice)).status,404);
    });
    await t.test('group names can be changed only by the group owner',async()=>{
      const r=await request('POST','/api/chats',{kind:'group',title:'Наша команда',usernames:['bob_test']},alice);const group=r.data.chat;
      assert.equal((await request('PATCH',`/api/chats/${group.id}`,{title:'Wrong'},bob)).status,403);assert.equal((await request('PATCH',`/api/chats/${group.id}`,{title:'Новая команда'},alice)).status,200);
      assert.equal((await request('PATCH',`/api/chats/${group.id}`,{muted:'yes'},alice)).status,400);
    });
    await t.test('SSE authenticates, scopes presence, and delivers between two sessions',async()=>{
      const controller=new AbortController();const response=await fetch(app.config.origin+'/api/events',{headers:{Cookie:bob.cookie},signal:controller.signal});assert.equal(response.status,200);const reader=response.body.getReader();let buffer='';
      const next=async type=>{const deadline=setTimeout(()=>controller.abort(),3000);try{for(;;){const {value,done}=await reader.read();if(done)throw new Error('stream ended');buffer+=Buffer.from(value).toString();const chunks=buffer.split('\n\n');buffer=chunks.pop();for(const chunk of chunks){const line=chunk.split('\n').find(s=>s.startsWith('data: '));if(line){const event=JSON.parse(line.slice(6));if(event.type===type)return event;}}}}finally{clearTimeout(deadline);}};
      const ready=await next('ready');assert(!ready.online.includes(outsider.user.id));
      const waiting=next('message');await request('POST',`/api/chats/${chat.id}/messages`,{text:'realtime delivery',clientId:randomUUID()},alice);const event=await waiting;assert.equal(event.message.text,'realtime delivery');assert.equal(event.chatId,chat.id);controller.abort();await reader.cancel().catch(()=>{});
    });
    await t.test('security headers forbid inline script, frames and API caching',async()=>{
      const r=await request('GET','/',undefined,alice);assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy'),/script-src 'self'/);assert.equal(r.headers.get('x-frame-options'),'DENY');const apiResponse=await request('GET','/api/chats',undefined,alice);assert.equal(apiResponse.headers.get('cache-control'),'no-store');
      assert.equal((await request('GET','/server/schema.sql')).status,404);
    });
    await t.test('invalid JSON, arrays, pagination and unsupported routes fail safely',async()=>{
      assert.equal((await request('POST','/api/chats','not-json',alice,{raw:true})).status,400);assert.equal((await request('POST','/api/chats',[],alice)).status,400);assert.equal((await request('GET',`/api/chats/${chat.id}/messages?limit=10000`,undefined,alice)).status,400);assert.equal((await request('GET','/api/unknown',undefined,alice)).status,404);
    });
    await t.test('message history and sessions survive a process restart',async()=>{
      await app.close();app=await createApplication({...loadConfig({}),dataDir:dir,port:0});await start();const r=await request('GET',`/api/chats/${chat.id}/messages`,undefined,alice);assert.equal(r.status,200);assert(r.data.messages.some(m=>m.id===message.id));
    });
    await t.test('logout revokes the cookie session and clears the browser cookie',async()=>{
      const r=await request('POST','/api/auth/logout',{},alice);assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/Max-Age=0/);assert.equal((await request('GET','/api/chats',undefined,alice)).status,401);
    });
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
