import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/server/store.js';
import { Service } from '../src/server/service.js';
test('project analysis uses original per-episode text, retries without duplicating, persists and rejects invalid boundaries', async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'workbench-project-test-'));
 const store=await Store.open(dir),service=new Service(store);
 let invalid=false;
 (service as any).codex=async()=>({json:{summary:'显式模拟分析',episodes:[{name:'第一集',startLine:1,endLine:invalid?99:2},{name:'第二集',startLine:3,endLine:4}]}});
 const idle=async()=>{for(let i=0;i<100;i++){if(!service.s.jobs.some(j=>['queued','running'].includes(j.status)))return;await new Promise(r=>setTimeout(r,20));}throw Error('job timed out');};
 try{
 const project=await service.command({type:'project.create',name:'剧集',script:'第一集\nA\n第二集\nB'});await idle();
 assert.deepEqual(service.s.episodes.map(e=>e.script),['第一集\nA','第二集\nB']);
 assert(service.s.episodes.every(e=>e.projectId===project.id));
 await service.command({type:'project.analyze',id:project.id});await idle();assert.equal(service.s.episodes.length,2);
 invalid=true;const job=await service.command({type:'project.analyze',id:project.id});await idle();assert.equal(job.status,'failed');assert.equal(service.s.episodes.length,2);
 await assert.rejects(()=>service.command({type:'episode.create',projectId:'missing',name:'x'}),/大项目不存在/);
 await service.shutdown();store.close();
 const reopened=await Store.open(dir);assert.equal(reopened.state.projects[0].script,project.script);assert.equal(reopened.state.episodes.length,2);reopened.close();
 }finally{await service.shutdown();await rm(dir,{recursive:true,force:true});}
});
