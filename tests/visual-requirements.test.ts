import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/server/store.js';
import { Service } from '../src/server/service.js';
import { applyVisualRequirements, visualRequirements } from '../src/server/visual-requirements.js';
import { preparationSignature } from '../src/server/preparation.js';
test('visual requirements inherit globally, scope lighting by scene and edits invalidate affected shots only',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'visual-requirements-'));const store=await Store.open(dir);const service=new Service(store);
 try{
 store.state.projects.push({id:'p',name:'大项目',script:'总剧本',summary:'',createdAt:''});
 const ep=await service.command({type:'episode.create',projectId:'p',name:'第一集'});
 const other=await service.command({type:'episode.create',name:'其他项目'});
 for(const e of [ep,other])store.state.assets.push({id:e.id,episodeId:e.id,name:'原片',path:'/fixture.mp4',kind:'video',role:'source',duration:10,createdAt:''});
 const a=await service.command({type:'shot.create',episodeId:ep.id,assetId:ep.id,in:0,out:5});
 const b=await service.command({type:'shot.create',episodeId:ep.id,assetId:ep.id,in:5,out:10});
 const c=await service.command({type:'shot.create',episodeId:other.id,assetId:other.id,in:0,out:5});
 Object.assign(a,{scene:'教堂',facts:'实拍事实',automated:true,confirmed:true});Object.assign(b,{scene:'树林',facts:'实拍事实',automated:true,confirmed:true});
 const original=preparationSignature(service.s,ep),ar=a.revision,br=b.revision,cr=c.revision;
 await service.command({type:'project.update',id:'p',patch:{visualStyle:'写实电影质感'}});
 assert.notEqual(preparationSignature(service.s,ep),original);assert.equal(a.revision,ar+1);assert.equal(b.revision,br+1);assert.equal(c.revision,cr);
 await service.command({type:'episode.sceneLook',id:ep.id,scene:'教堂',look:'暖色烛光'});
 await service.command({type:'episode.sceneLook',id:ep.id,scene:'树林',look:'冷色月光'});
 const br2=b.revision;
 await service.command({type:'shot.update',id:a.id,patch:{requirements:'只替换本镜背景'}});
 assert.equal(b.revision,br2);assert(a.confirmed);
 store.state.projects[0].visualBrief='旧字段不得驱动新生成';
 const context=visualRequirements(service.s,ep.id,[a.id]);assert.match(context,/写实电影质感/);assert.match(context,/AI\+实拍内置生产规则/);assert.match(context,/原演员身份/);assert.match(context,/原声台词与口型同步/);assert.doesNotMatch(context,/旧字段不得驱动新生成/);assert.doesNotMatch(context,/大项目统一画面要求/);assert.match(context,/暖色烛光/);assert.match(context,/只替换本镜背景/);assert.doesNotMatch(context,/冷色月光/);
 const prompt=applyVisualRequirements(applyVisualRequirements('原提示词',context),context);assert.equal(prompt.split('【当前分层画面要求】').length,2);
 assert.doesNotMatch(visualRequirements(service.s,other.id),/写实电影质感/);
 assert.match(visualRequirements(service.s,other.id),/AI\+实拍内置生产规则/);
 }finally{await service.shutdown();store.close();await rm(dir,{recursive:true,force:true});}
});
