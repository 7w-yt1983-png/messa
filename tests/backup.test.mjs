import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../server/db.mjs';

test('offline backup verifies files, restores SQLite and never overwrites',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'messa-backup-'));const source=path.join(root,'source'),destination=path.join(root,'copy');
  try{
    const db=openDatabase(source);db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run('u','sample','Sample','hash','blue','',1);db.prepare('INSERT INTO chats VALUES (?,?,?,?,?,?,?)').run('c','saved','Saved','u',null,1,1);db.prepare('INSERT INTO files VALUES (?,?,?,?,?,?,?)').run('f','c','u','note.txt','application/octet-stream',5,1);db.close();await writeFile(path.join(source,'uploads','f'),'hello');
    const args=['scripts/backup.mjs',destination];
    const blocked=spawnSync(process.execPath,args,{env:{...process.env,DATA_DIR:source,MESSA_BACKUP_OFFLINE:'0'},encoding:'utf8'});assert.notEqual(blocked.status,0);
    const env={...process.env,DATA_DIR:source,MESSA_BACKUP_OFFLINE:'1'};
    const good=spawnSync(process.execPath,args,{env,encoding:'utf8'});assert.equal(good.status,0,good.stderr);
    const manifest=JSON.parse(await readFile(path.join(destination,'manifest.json'),'utf8'));assert.equal(manifest.files.length,1);assert.equal(manifest.files[0].sha256.length,64);assert.equal(await readFile(path.join(destination,'uploads','f'),'utf8'),'hello');
    const restored=new DatabaseSync(path.join(destination,'messa.sqlite'),{readOnly:true});assert.equal(restored.prepare('SELECT count(*) n FROM files').get().n,1);restored.close();
    const collision=spawnSync(process.execPath,args,{env,encoding:'utf8'});assert.notEqual(collision.status,0);assert.equal(await readFile(path.join(destination,'uploads','f'),'utf8'),'hello');
  }finally{await rm(root,{recursive:true,force:true});}
});
