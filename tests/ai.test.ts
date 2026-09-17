import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { checkCodex, runCodex, compileEpisode, compileSegment, imagePathsFromEvent, submitVideo, getVideoTask, downloadVideo, UncertainSubmissionError } from '../src/server/ai.js';
import { bindVideoPrompt, validateRemoteMediaURL } from '../src/server/providers/seedance.js';
import type { Asset, Episode, Segment, Settings, Shot, Take } from '../src/shared/types.js';

const settings: Settings = { llmProvider:'codex', imageProvider:'codex', llmApiBaseUrl:'', llmApiKey:'', llmApiModel:'', imageApiBaseUrl:'', imageApiKey:'', imageApiModel:'', codexPath: 'codex', codexModel: '', ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', apiBaseUrl: '', apiKey: 'test-key-only', videoModel: 'fixture-model-not-a-live-id', uploadBaseUrl: '', videoDurationLimit: 30, resolution: '720p', ratio: '16:9', generateAudio: true, dataDir: '', imageCapability: '' };
const episode: Episode = { id:'ep', name:'本集', script:'本集事实', brief:'保持表演', look:'室外日景保持自然', fullPrompt:'用户修改过的本集约束', skipImages:false, createdAt:'', revision:1 };
const asset = (id: string, role = 'source', episodeId = 'ep'): Asset => ({ id, name:id, role, episodeId, kind: role === 'source' ? 'video' : 'image', path:`/${id}`, createdAt:'' });
const shot = (id: string, source: string, start: number, end: number): Shot => ({ id, episodeId:'ep', assetId:source, name:id, in:start, out:end, scene:'日景', facts:`${id}接触关系不得改变`, plan:'只改服装', imagePrompt:'', videoPrompt:'保留运镜', referenceIds:[], skipImage:false, confirmed:true, revision:1 });
async function fakeServer(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const server = createServer(async (req, res) => { let body = ''; for await (const data of req) body += data.toString(); handler(req, res, body); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  return { base: `http://127.0.0.1:${address.port}/api/v3`, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

test('episode scoping and segment-local timecodes preserve facts and bind only approved candidates', () => {
  const a = shot('镜头甲','source-a',100,102); const b = shot('镜头乙','source-b',210,213);
  a.referenceIds = ['approved-look','candidate','foreign']; a.approvedImageId = 'approved-take';
  const assets = [asset('source-a'),asset('source-b'),asset('approved-look','look'),asset('candidate','image-take'),asset('foreign','look','other'),asset('approved-image','image-take')];
  const takes = [{ id:'approved-take', episodeId:'ep', kind:'image', shotId:a.id, assetId:'approved-image', status:'approved', sourceRevision:1 } as Take, {id:'candidate-take',episodeId:'ep',kind:'image',shotId:a.id,assetId:'candidate',status:'candidate'} as Take];
  const segment: Segment = { id:'seg', episodeId:'ep', name:'片段', clips:[{id:'c1',shotId:a.id,assetId:a.assetId,in:100,out:102},{id:'c2',shotId:b.id,assetId:b.assetId,in:210,out:213}], prompt:'', mode:'edit', duration:5, revision:1 };
  const prompt = compileSegment(episode,segment,[a,b],assets,takes);
  assert.match(prompt,/片段内 0\.000s–2\.000s/); assert.match(prompt,/片段内 2\.000s–5\.000s/);
  assert.match(prompt,/100\.000s–102\.000s/); assert.match(prompt,/210\.000s–213\.000s/);
  assert.match(prompt,/approved-image/); assert.match(prompt,/approved-look/); assert.match(prompt,/用户修改过的本集约束/);
  assert.doesNotMatch(prompt,/candidate|foreign/); assert.match(prompt,/镜头甲接触关系不得改变/);
  const other = {...b,episodeId:'other',name:'其他集禁止出现'};
  assert.doesNotMatch(compileEpisode(episode,[a,other],assets),/其他集禁止出现|foreign/);
  assert.throws(()=>compileSegment(episode,{...segment,episodeId:'other'},[a,b],assets,takes),/不属于/);
});

test('Codex adapter uses argument arrays, structured output, attachments and actual image files (fake CLI contract)', async () => {
  const dir = await mkdtemp(join(tmpdir(),'workbench-ai-cli-'));
  try {
    const cli = join(dir,'fake codex'); const input = join(dir,'输入 图.png'); const generated = join(dir,'generated.png');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=','base64');
    await writeFile(input,png); await writeFile(generated,png);
    await writeFile(cli, `#!${process.execPath}\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);\nif(args.includes('--version')){console.log('codex-cli 0.fixture');process.exit(0)}\nif(args[0]==='login'){console.error('Logged in using ChatGPT');process.exit(0)}\nif(args[0]==='features'){console.log('image_generation stable true');process.exit(0)}\nlet prompt='';for await(const chunk of process.stdin) prompt+=chunk;\nfs.writeFileSync(${JSON.stringify(join(dir,'args.json'))},JSON.stringify({args,prompt}));\nconst output=args[args.indexOf('-o')+1];const text=JSON.stringify({ok:true});fs.writeFileSync(output,text);\nconsole.log(JSON.stringify({type:'thread.started',thread_id:'fixture-thread'}));\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'imageGeneration',savedPath:${JSON.stringify(generated)},status:'completed'}}));\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));\nconsole.log(JSON.stringify({type:'turn.completed'}));\n`);
    await chmod(cli,0o755);
    const status = await checkCodex({...settings,codexPath:cli}); assert.equal(status.authenticated,true); assert.equal(status.imageAvailable,true);
    const result = await runCodex({...settings,codexPath:cli},{prompt:'保留动作',images:[input],cwd:dir,outputPath:join(dir,'result.json'),schema:{type:'object'},image:true});
    assert.deepEqual(result.json,{ok:true}); assert.equal(result.threadId,'fixture-thread'); assert.equal(result.images.length,1);
    assert.deepEqual(await readFile(result.images[0]),png); assert.notEqual(result.images[0],generated);
    const captured=JSON.parse(await readFile(join(dir,'args.json'),'utf8')); assert.deepEqual(captured.args.slice(0,3),['-a','never','exec']);
    assert.equal(captured.args[captured.args.indexOf('-i')+1],input); assert(captured.args.includes('--output-schema')); assert.match(captured.prompt,/只生成一个候选/);
    await assert.rejects(runCodex({...settings,codexPath:cli},{prompt:'x',cwd:dir,outputPath:join(dir,'result.json')}),/输出路径已存在/);
    assert.deepEqual(imagePathsFromEvent({item:{saved_path:'/actual.png'}}),['/actual.png']);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('Seedance contract: uploads local video, embeds image, preserves edit duration, polls and downloads', async () => {
  const dir = await mkdtemp(join(tmpdir(),'workbench-ai-provider-')); let posts=0; let uploaded=false; let payload:any;
  const server = await fakeServer((req,res,body)=>{
    res.setHeader('Content-Type','application/json'); assert.equal(req.headers.authorization,'Bearer test-key-only');
    if(req.url==='/api/v3/files') { assert.match(body,/name="purpose"\r\n\r\nuser_data/); assert.match(body,/name="file"/); uploaded=true; res.end(JSON.stringify({id:'file-fixture',status:'active',download_url:'https://cdn.example.com/source.mp4?signature=secret'})); }
    else if(req.method==='POST') { posts++; payload=JSON.parse(body); res.end(JSON.stringify({id:'task-fixture'})); }
    else res.end(JSON.stringify({id:'task-fixture',status:'succeeded',content:{video_url:'https://cdn.example.com/generated.mp4'}}));
  });
  try {
    const video=join(dir,'source.mp4'); const image=join(dir,'ref.png'); await writeFile(video,'video-fixture');await writeFile(image,'image-fixture');
    const config={...settings,apiBaseUrl:server.base}; let bound='';
    const submitted=await submitVideo(config,{prompt:'编辑视频保持原表演',inputs:[{kind:'video',path:video},{kind:'image',path:image}],duration:5.5,mode:'edit'},(_,url)=>{bound=url;});
    assert(uploaded); assert.equal(posts,1); assert.equal(submitted.id,'task-fixture');assert.equal(payload.duration,-1);assert.equal(payload.ratio,'adaptive');assert.equal(payload.generate_audio,true);assert.equal(payload.omni_reference_task_type,'edit');
    assert.equal(payload.content[1].role,'reference_video');assert.match(payload.content[2].image_url.url,/^data:image\/png;base64,/);assert.match(bound,/signature=secret/);
    assert.doesNotMatch(JSON.stringify(submitted.request),/signature=secret|aW1hZ2UtZml4dHVyZQ==|test-key-only/);
    await submitVideo(config,{prompt:'全能参考',inputs:[{kind:'image',path:image}],duration:8,mode:'reference',ratio:'9:16',resolution:'1080p'});
    assert.equal(posts,2);assert.equal(payload.duration,8);assert.equal(payload.ratio,'9:16');assert.equal(payload.resolution,'1080p');assert.equal(payload.generate_audio,true);assert.equal(payload.omni_reference_task_type,'reference');
    const task=await getVideoTask(config,submitted.id);assert.equal(task.status,'succeeded');assert.equal(task.url,'https://cdn.example.com/generated.mp4');
  } finally { await server.close();await rm(dir,{recursive:true,force:true}); }
  const download=await fakeServer((_req,res)=>{res.setHeader('Content-Type','video/mp4');res.end('download-fixture');});
  const output=join(tmpdir(),`workbench-ai-download-${Date.now()}.mp4`);
  try {await downloadVideo(`${download.base}/result`,output);assert.equal(await readFile(output,'utf8'),'download-fixture');await assert.rejects(downloadVideo(`${download.base}/result`,output),/已存在/);}
  finally {await download.close();await rm(output,{force:true});}
});

test('Seedance never retries unknown submissions and distinguishes safe failures', async () => {
  for(const status of [400,500,200]) {
    let posts=0;const server=await fakeServer((_req,res)=>{posts++;res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(status===200?{}:{error:{message:'fixture failure'}}));});
    try {
      await assert.rejects(submitVideo({...settings,apiBaseUrl:server.base},{prompt:'参考生成',inputs:[],duration:5,mode:'reference'}),(error:any)=>{assert.equal(error.submissionUncertain,status!==400);assert.equal(error instanceof UncertainSubmissionError,status!==400);return true;});
      assert.equal(posts,1);
    }finally{await server.close();}
  }
  await assert.rejects(submitVideo({...settings,apiBaseUrl:'https://example.com'},{prompt:'x',inputs:[],duration:2,mode:'reference'}),(error:any)=>error.submissionUncertain===false);
  await assert.rejects(submitVideo({...settings,apiBaseUrl:'https://example.com'},{prompt:'x',inputs:[],duration:5.2,mode:'reference'}),/整数秒/);
});

test('remote media inputs reject machine-local URLs and preserve valid signed URLs',()=>{
  for(const url of ['http://localhost:4100/media/id','http://127.0.0.1/x','http://10.1.2.3/x','http://192.168.1.1/x','http://[::1]/x','file:///tmp/a.mp4','http://pc.local/x']) assert.throws(()=>validateRemoteMediaURL(url));
  assert.equal(validateRemoteMediaURL('https://cdn.example.com/a.mp4?signature=123'),'https://cdn.example.com/a.mp4?signature=123');
  assert.equal(validateRemoteMediaURL('asset://example-id'),'asset://example-id');
});

test('Seedance prompt bindings use independent media numbering and preserve the editable prompt', () => {
  const prompt = '原样保留这一段中文、时间码 0–5s，以及 @Image 2 的衣服要求。';
  const text = bindVideoPrompt({ prompt, duration: 5, mode: 'edit', inputs: [
    {kind:'video',name:'原片'}, {kind:'image',name:'日景场景（id-scene）'},
    {kind:'audio',name:'原声'}, {kind:'video',name:'动作参考'}, {kind:'image',name:'服装（id-costume）'},
  ] });
  assert.match(text, /@Video 1 = "原片"/); assert.match(text, /@Image 1 = "日景场景（id-scene）"/);
  assert.match(text, /@Audio 1 = "原声"/); assert.match(text, /@Video 2 = "动作参考"/);
  assert.match(text, /@Image 2 = "服装（id-costume）"/); assert(text.endsWith(prompt));
  assert.doesNotMatch(text, /@Image 5|@Video 4/);
});
