import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

let count=0;
for(const dir of ['server','public','scripts','tests']){
  for(const name of await readdir(dir)){
    if(!/\.(mjs|js)$/.test(name))continue;
    const filename=path.join(dir,name);
    const result=spawnSync(process.execPath,['--check',filename],{stdio:'inherit'});
    if(result.status!==0)process.exit(result.status||1);
    count++;
  }
}
const source=await readFile('public/index.html','utf8');
if(/\son[a-z]+=/i.test(source))throw new Error('Inline handlers violate the Content Security Policy.');
JSON.parse(await readFile('public/manifest.webmanifest','utf8'));
JSON.parse(await readFile('package.json','utf8'));
console.log(`Syntax checked: ${count} JavaScript modules; HTML CSP and JSON sanity checks passed.`);
