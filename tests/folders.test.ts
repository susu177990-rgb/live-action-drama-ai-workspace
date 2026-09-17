import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {Store} from '../src/server/store.js';
import {Service} from '../src/server/service.js';
test('folder selection cancels without mutation and new storage/exports persist without moving existing files',async()=>{
 const dir=await mkdtemp(path.resolve('.workbench/verification-folders-'));let store=await Store.open(dir);let chosen:string|null=null;let service=new Service(store,async()=>chosen);
 try{
  const old=await service.output('imports','.txt');await writeFile(old,'existing');
  assert.equal(await service.command({type:'settings.chooseFolder',kind:'storage'}),null);
  const storage=path.join(dir,'new storage'),exports=path.join(dir,'new exports');await mkdir(storage);await mkdir(exports);chosen=storage;
  assert.equal(await service.command({type:'settings.chooseFolder',kind:'storage'}),storage);assert.equal(store.state.settings.storageDir,'');
  await service.command({type:'settings.update',patch:{storageDir:storage,exportDir:exports}});
  assert.equal(path.dirname(await service.output('imports','.txt')),path.join(storage,'imports'));
  const ep=await service.command({type:'episode.create',name:'路径验收'});
  const job=await service.command({type:'export.project',episodeId:ep.id});
  for(let i=0;i<200&&['queued','running'].includes(job.status);i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(job.status,'succeeded');const asset=service.s.assets.find(a=>a.id===job.resultId)!;assert.equal(path.dirname(asset.path),exports);assert.equal(JSON.parse(await readFile(asset.path,'utf8')).episode.name,'路径验收');
  assert.equal(await readFile(old,'utf8'),'existing');
  await service.shutdown();store.close();store=await Store.open(dir);service=new Service(store);
  assert.equal(store.state.settings.storageDir,storage);assert.equal(store.state.settings.exportDir,exports);
  await assert.rejects(service.command({type:'settings.update',patch:{exportDir:path.join(dir,'missing')}}),/不存在/);
 }finally{await service.shutdown();store.close();await rm(dir,{recursive:true,force:true});}
});
