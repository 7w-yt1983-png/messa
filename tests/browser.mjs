// Optional browser suite: npm install --no-save --package-lock=false playwright@1.63.0
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
const base=process.env.MESSA_URL||'http://localhost:3000';
const output=process.env.ARTIFACT_DIR||'artifacts';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const errors=[];
const context=await browser.newContext({viewport:{width:1440,height:960},reducedMotion:'reduce'});
const other=await browser.newContext({viewport:{width:1100,height:850}});
const page=await context.newPage(),peer=await other.newPage();
for(const p of [page,peer])p.on('pageerror',error=>errors.push(error.message));
const suffix=Date.now().toString(36),alice='e2e_a_'+suffix,bob='e2e_b_'+suffix;
async function signup(p,handle,name){
  await p.goto(base);await p.getByRole('button',{name:'Создать аккаунт',exact:true}).click();
  await p.locator('[name=displayName]').fill(name);await p.locator('[name=username]').fill(handle);await p.locator('[name=password]').fill('Browser test passphrase!');
  await p.locator('#auth-submit').click();await p.locator('#app').waitFor({state:'visible'});await p.locator('.chat-item').first().waitFor();
}
async function noOverflow(p){assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Horizontal overflow at ${p.viewportSize().width}px`);}
async function waitForText(p,text){await p.locator('.message-text').filter({hasText:text}).first().waitFor({timeout:10000});}
try{
  await page.goto(base);await page.screenshot({path:output+'/auth-desktop.png'});await noOverflow(page);
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:output+'/auth-mobile.png'});await noOverflow(page);await page.setViewportSize({width:1440,height:960});
  await signup(page,alice,'Алиса Тест');await signup(peer,bob,'Борис Тест');
  await page.getByRole('button',{name:'Новый чат',exact:true}).click();await page.locator('#people-search').fill(bob);
  await page.locator('[data-person]').first().click();await page.locator('#create-chat-button').click();await page.locator('#chat-header h2').filter({hasText:'Борис Тест'}).waitFor();
  await page.locator('#composer-input').fill('Проверка живой доставки');await page.locator('#composer-input').press('Enter');
  await peer.locator('.chat-item').filter({hasText:'Алиса Тест'}).click();await waitForText(peer,'Проверка живой доставки');
  await peer.locator('#composer-input').fill('Ответ со второго аккаунта');await peer.locator('#composer-input').press('Enter');await waitForText(page,'Ответ со второго аккаунта');
  await page.locator('.message.own .receipt.read').first().waitFor();
  const received=page.locator('article.message').filter({hasText:'Ответ со второго аккаунта'});
  await received.getByRole('button',{name:'Действия с сообщением'}).click();await page.getByRole('button',{name:'Реакция ❤️',exact:true}).click();await peer.locator('.reaction').filter({hasText:'❤️'}).waitFor();
  await received.getByRole('button',{name:'Действия с сообщением'}).click();await page.getByRole('button',{name:'Ответить',exact:true}).click();await page.locator('#composer-input').fill('Ответ с цитатой');await page.locator('#composer-input').press('Enter');await peer.locator('.reply-quote').waitFor();
  const mine=page.locator('article.message.own').filter({hasText:'Проверка живой доставки'});await mine.getByRole('button',{name:'Действия с сообщением'}).click();await page.getByRole('button',{name:'Редактировать',exact:true}).click();await page.locator('#composer-input').fill('Сообщение после редактирования');await page.locator('#composer-input').press('Enter');await waitForText(peer,'Сообщение после редактирования');
  await page.locator('#file-input').setInputFiles({name:'заметка.txt',mimeType:'text/plain',buffer:Buffer.from('private attachment')});await page.locator('#attachment-preview').filter({hasText:'Готов к отправке'}).waitFor();await page.locator('#send-button').click();await peer.locator('.file-card').filter({hasText:'заметка.txt'}).waitFor();
  // User-supplied markup stays literal, never executable.
  await page.locator('#composer-input').fill('<img src=x onerror="window.XSS=true">');await page.locator('#composer-input').press('Enter');await waitForText(peer,'<img src=x');assert.equal(await peer.evaluate(()=>window.XSS),undefined);
  await page.getByRole('button',{name:'Поиск сообщений',exact:true}).click();await page.locator('#message-search').fill('редактирования');await page.waitForTimeout(500);await waitForText(page,'Сообщение после редактирования');assert.equal(await page.locator('.message').count(),1);await page.getByRole('button',{name:'Закрыть поиск'}).click();
  await page.locator('#composer-input').fill('Этот черновик должен сохраниться');await page.reload();await page.locator('#composer-input').waitFor();assert.equal(await page.locator('#composer-input').inputValue(),'Этот черновик должен сохраниться');await page.locator('#composer-input').fill('');
  await page.getByRole('button',{name:'Информация о чате',exact:true}).click();await page.screenshot({path:output+'/live-desktop.png'});await noOverflow(page);await page.getByRole('button',{name:'Закрыть информацию',exact:true}).click();
  await page.getByRole('button',{name:'Настройки',exact:true}).click();await page.locator('[data-theme-choice=dark]').click();await page.screenshot({path:output+'/settings-dark.png'});await page.getByRole('button',{name:'Закрыть',exact:true}).click();
  // On transport failure the message stays retryable; reconnect + retry cannot duplicate it.
  await context.setOffline(true);await page.locator('#composer-input').fill('Сообщение после восстановления сети');await page.locator('#composer-input').press('Enter');await page.locator('.retry-button').waitFor();await context.setOffline(false);await page.locator('.retry-button').click();await waitForText(peer,'Сообщение после восстановления сети');assert.equal(await peer.locator('.message-text').filter({hasText:'Сообщение после восстановления сети'}).count(),1);
  await page.setViewportSize({width:390,height:844});if(await page.getByRole('button',{name:'К списку чатов',exact:true}).isVisible())await page.getByRole('button',{name:'К списку чатов',exact:true}).click();await page.screenshot({path:output+'/live-mobile-list.png'});await noOverflow(page);await page.locator('.chat-item').filter({hasText:'Борис Тест'}).click();await waitForText(page,'Сообщение после восстановления сети');await page.locator('#toast').waitFor({state:'hidden'});await page.screenshot({path:output+'/live-mobile-chat.png'});await noOverflow(page);
  await page.getByRole('button',{name:'К списку чатов',exact:true}).click();await page.getByRole('button',{name:'Настройки',exact:true}).click();await page.getByRole('button',{name:'Выйти из аккаунта',exact:true}).click();await page.locator('#auth').waitFor({state:'visible'});
  assert.equal(await page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('messa:')).length),0);
  assert.deepEqual(errors,[]);
  console.log('PASS: two-account realtime, receipts, reactions, replies, edits, files, XSS, search, drafts, offline retry, mobile layout, themes and logout.');
}finally{await context.close();await other.close();await browser.close();}
