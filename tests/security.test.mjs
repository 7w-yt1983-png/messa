import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, equal, username, password, integer, RateLimiter, sniffImage } from '../server/security.mjs';
import { loadConfig } from '../server/config.mjs';

test('passwords use randomized scrypt hashes and reject incorrect passwords', async () => {
  const a = await hashPassword('a long test passphrase');
  const b = await hashPassword('a long test passphrase');
  assert.notEqual(a,b); assert(!a.includes('passphrase'));
  assert.equal(await verifyPassword('a long test passphrase',a),true);
  assert.equal(await verifyPassword('wrong test passphrase',a),false);
});
test('token comparison rejects absent and different tokens',()=>{assert(equal('same','same'));assert(!equal('a','b'));assert(!equal(undefined,'a'));});
test('username validation normalizes case and excludes unsafe identifiers',()=>{assert.equal(username(' Alice_123 '),'alice_123');for(const value of ['ab','with space','<script>','пользователь',null,[]])assert.throws(()=>username(value));});
test('password bounds are enforced',()=>{assert.throws(()=>password('short'));assert.throws(()=>password('x'.repeat(129)));assert.equal(password('x'.repeat(12)).length,12);});
test('pagination rejects floats, negatives, unsafe values and nonsense',()=>{assert.equal(integer(null,50),50);assert.equal(integer('20',50),20);for(const value of ['NaN','1.2','-1','9007199254740992'])assert.throws(()=>integer(value));});
test('rate limiter bounds burst requests and expires old buckets',()=>{const limit=new RateLimiter();limit.take('user',2,60000);limit.take('user',2,60000);assert.throws(()=>limit.take('user',2,60000),{status:429});limit.take('expired',1,0);limit.prune();assert(!limit.buckets.has('expired'));});
test('file MIME is sniffed and never trusts SVG or HTML',()=>{assert.equal(sniffImage(Buffer.from('<svg onload="alert(1)">')),'application/octet-stream');assert.equal(sniffImage(Buffer.from('<html>')),'application/octet-stream');assert.equal(sniffImage(Buffer.from([137,80,78,71,13,10,26,10])),'image/png');assert.equal(sniffImage(Buffer.from([255,216,255,0])),'image/jpeg');});
test('production fails closed without HTTPS and private registration settings',()=>{assert.throws(()=>loadConfig({NODE_ENV:'production'}));assert.throws(()=>loadConfig({NODE_ENV:'production',APP_ORIGIN:'https://chat.example',ALLOW_REGISTRATION:'true'}));const config=loadConfig({NODE_ENV:'production',APP_ORIGIN:'https://chat.example'});assert.equal(config.registration,false);assert.equal(config.cookie,'__Host-messa');assert.throws(()=>loadConfig({APP_ORIGIN:'https://chat.example/path'}));assert.throws(()=>loadConfig({PORT:'not-a-port'}));});
