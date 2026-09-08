import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, cp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

process.umask(0o077);
if(process.env.MESSA_BACKUP_OFFLINE!=='1')throw new Error('Stop the Messa server, then set MESSA_BACKUP_OFFLINE=1. This acknowledgement is required for a consistent database + attachments backup.');
const source=path.resolve(process.env.DATA_DIR||'data');
const destination=path.resolve(process.argv[2]||`backups/${new Date().toISOString().replace(/[:.]/g,'-')}`);
if(destination===source||destination.startsWith(source+path.sep))throw new Error('Backup destination must be outside DATA_DIR.');
const db=new DatabaseSync(path.join(source,'messa.sqlite'),{readOnly:true});
let created=false;
try{
  await mkdir(path.dirname(destination),{recursive:true,mode:0o700});
  await mkdir(destination,{mode:0o700});created=true; // Never overwrite an existing backup.
  await backup(db,path.join(destination,'messa.sqlite'));
  await cp(path.join(source,'uploads'),path.join(destination,'uploads'),{recursive:true,errorOnExist:true,force:false});
  const files=db.prepare('SELECT id,size FROM files ORDER BY id').all();
  const manifest={format:1,createdAt:new Date().toISOString(),databaseSha256:createHash('sha256').update(await readFile(path.join(destination,'messa.sqlite'))).digest('hex'),files:[]};
  for(const file of files){const filename=path.join(destination,'uploads',file.id);if((await stat(filename)).size!==file.size)throw new Error(`Incomplete file in backup: ${file.id}`);manifest.files.push({id:file.id,size:file.size,sha256:createHash('sha256').update(await readFile(filename)).digest('hex')});}
  const check=new DatabaseSync(path.join(destination,'messa.sqlite'),{readOnly:true});
  try{if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('SQLite integrity check failed.');}finally{check.close();}
  await writeFile(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
  console.log(`Verified offline backup written to ${destination}. It contains private data: encrypt and restrict access.`);
}catch(error){if(created)await rm(destination,{recursive:true,force:true});throw error;}
finally{db.close();}
