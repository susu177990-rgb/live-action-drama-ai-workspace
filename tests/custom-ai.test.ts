import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, chmod, stat } from 'node:fs/promises';
import path from 'node:path';
import { Store, defaultSettings } from '../src/server/store.js';
import { Service } from '../src/server/service.js';
import { runCustomAI } from '../src/server/providers/custom-ai.js';
import { CodexConnection } from '../src/server/codex-connection.js';
const root=path.resolve('.workbench');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTRsAAAAASUVORK5CYII=','base64');

test('custom LLM and image requests carry independent keys, multimodal inputs and actual image bytes; errors do not leak keys',async()=>{
 const dir=await mkdtemp(path.join(root,'verification-custom-api-'));const calls:any[]=[];
 const server=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;calls.push({url:req.url,auth:req.headers.authorization,apiKey:req.headers['x-api-key'],body});res.setHeader('Content-Type','application/json');if(req.url==='/bad/chat/completions'){res.statusCode=401;res.end(JSON.stringify({error:{message:'invalid llm-secret-fixture'}}));}else res.end(JSON.stringify(req.url?.endsWith('/images/edits')?{data:[{b64_json:png.toString('base64')}]}:{choices:[{message:{content:'{"ok":true}'}}]}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(server.address() as any).port}`;
 try{
  const settings={...defaultSettings(dir),llmApiBaseUrl:base+'/v1',imageApiBaseUrl:base+'/v1',llmApiModel:'vision-model',imageApiModel:'edit-model',llmApiKey:'llm-secret-fixture',imageApiKey:'image-secret-fixture'};
  const file=path.join(dir,'ref.png');await writeFile(file,png);
  const schema={type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false};
  const result=await runCustomAI(settings,{prompt:'素材分析',images:[file],cwd:dir,outputPath:path.join(dir,'llm.json'),schema});
  assert.equal(result.json.ok,true);const payload=JSON.parse(calls[0].body);assert.equal(payload.response_format.json_schema.schema.type,'object');assert.match(payload.messages[0].content[1].image_url.url,/^data:image\/png;base64,/);assert.equal(calls[0].auth,'Bearer llm-secret-fixture');assert.equal(calls[0].apiKey,'llm-secret-fixture');
  await runCustomAI({...settings,llmApiBaseUrl:base+'/v1/chat/completions'},{prompt:'完整地址兼容测试',cwd:dir,outputPath:path.join(dir,'full-url.json')});
  assert.equal(calls[1].url,'/v1/chat/completions','a complete endpoint URL must not be appended twice');
  const generated=await runCustomAI(settings,{prompt:'编辑原图',images:[file],image:true,cwd:dir,outputPath:path.join(dir,'image.json')});
  assert.equal(calls[2].url,'/v1/images/edits');assert.equal(calls[2].auth,'Bearer image-secret-fixture');assert.equal(calls[2].apiKey,'image-secret-fixture');assert.match(calls[2].body,/name="image\[\]"/);assert.deepEqual(await readFile(generated.images[0]),png);
  const store=await Store.open(dir);const service=new Service(store);
  try {
    Object.assign(store.state.settings,settings,{codexPath:'/missing-cli-must-not-run',llmProvider:'custom',imageProvider:'custom'});
    const ep=await service.command({type:'episode.create',name:'自定义路由验收'});
    const job:any={id:'route-fixture',episodeId:ep.id,targetId:ep.id,type:'ai.image',status:'running',progress:0,message:'',payload:{}};
    const llm=await (service as any).codex(job,'分析',[file],schema,false);
    assert.equal(llm.json.ok,true);
    const image=await (service as any).codex(job,'编辑',[file],undefined,true);
    assert.deepEqual(await readFile(image.images[0]),png);
    const llmTest=await service.command({type:'settings.apiTest',kind:'llm'});assert.match(llmTest.message,/连接成功/);
    const imageTest=await service.command({type:'settings.apiTest',kind:'image'});assert.match(imageTest.message,/连接成功/);
  }finally{await service.shutdown();store.close();}
  await assert.rejects(runCustomAI({...settings,llmApiBaseUrl:base+'/bad'},{prompt:'test',cwd:dir,outputPath:path.join(dir,'bad.json')}),e=>e instanceof Error&&!e.message.includes(settings.llmApiKey)&&e.message.includes('401'));
 }finally{await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});

test('custom keys persist separately from database/public state and modes survive restart',async()=>{
 const dir=await mkdtemp(path.join(root,'verification-custom-secrets-'));let store=await Store.open(dir);let service=new Service(store);
 try{
  await service.command({type:'settings.update',patch:{llmProvider:'custom',imageProvider:'codex',llmApiKey:'test-llm-key-unique',imageApiKey:'test-image-key-unique',llmApiBaseUrl:'https://example.invalid/v1',llmApiModel:'vision'}});
  const publicText=JSON.stringify(store.publicState());assert(!publicText.includes('test-llm-key-unique'));assert(!publicText.includes('test-image-key-unique'));assert(store.publicState().llmApiKeySet);
  const db=await readFile(path.join(dir,'workbench.sqlite'));assert(!db.includes(Buffer.from('test-llm-key-unique')));assert(!db.includes(Buffer.from('test-image-key-unique')));
  assert.equal((await stat(path.join(dir,'secrets.json'))).mode&0o777,0o600);
  await service.shutdown();store.close();store=await Store.open(dir);service=new Service(store);
  assert.equal(store.state.settings.llmApiKey,'test-llm-key-unique');assert.equal(store.state.settings.imageApiKey,'test-image-key-unique');assert.equal(store.state.settings.llmProvider,'custom');assert.equal(store.state.settings.imageProvider,'codex');
  const secrets=await service.command({type:'settings.secrets'});assert.equal(secrets.llmApiKey,'test-llm-key-unique');assert.equal(secrets.imageApiKey,'test-image-key-unique');
  await service.command({type:'settings.update',patch:{llmApiKey:'',imageApiKey:''}});assert.equal(store.state.settings.llmApiKey,'test-llm-key-unique');
  await assert.rejects(service.command({type:'settings.update',patch:{llmProvider:'unknown'}}));
 }finally{await service.shutdown();store.close();await rm(dir,{recursive:true,force:true});}
});

test('unified Codex connection launches login when needed and verifies real CLI output (fake CLI contract)',async()=>{
 const dir=await mkdtemp(path.join(root,'verification-codex-login-'));const cli=path.join(dir,'fake-codex.mjs');
 await writeFile(cli,`#!${process.execPath}\nimport fs from 'node:fs';const args=process.argv.slice(2);const flag=${JSON.stringify(path.join(dir,'login'))};if(args[0]==='--version')console.log('fixture-cli');else if(args[0]==='features')console.log('image_generation stable true');else if(args[0]==='login'&&args[1]==='status'){console.log(fs.existsSync(flag)?'Logged in using ChatGPT':'Not logged in');process.exit(fs.existsSync(flag)?0:1);}else if(args[0]==='login'){fs.writeFileSync(flag,'ok');console.log('logged in');}else{fs.writeFileSync(args[args.indexOf('-o')+1],'WORKBENCH_OK');console.log(JSON.stringify({type:'turn.completed'}));}\n`);await chmod(cli,0o755);
 const connection=new CodexConnection();try{
  const settings={...defaultSettings(dir),codexPath:cli};assert.equal((await connection.inspect(settings)).authenticated,false);
  connection.connect(settings);connection.connect(settings);
  for(let i=0;i<200&&connection.state.status!=='connected'&&connection.state.status!=='failed';i++)await new Promise(r=>setTimeout(r,20));
  assert.equal(connection.state.status,'connected',connection.state.message);assert.equal(connection.state.authenticated,true);assert.equal(connection.state.loginUrl,'');
 }finally{connection.cancel();await rm(dir,{recursive:true,force:true});}
});
