import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import path from 'node:path';
import {listCodexModels} from '../src/server/codex-models.js';
test('Codex catalog follows pagination and includes returned hidden models without hardcoding',async()=>{
 const dir=await mkdtemp(path.resolve('.workbench/verification-models-'));const cli=path.join(dir,'cli.mjs');
 try{
 await writeFile(cli,`#!${process.execPath}\nimport readline from 'node:readline';for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));else if(m.method==='model/list'){if(!m.params.includeHidden)process.exit(1);console.log(JSON.stringify({id:m.id,result:m.params.cursor?{data:[{model:'second',displayName:'Second',hidden:true}],nextCursor:null}:{data:[{model:'first',displayName:'First',isDefault:true}],nextCursor:'page2'}}));}}`);await chmod(cli,0o755);
 assert.deepEqual(await listCodexModels(cli),[{model:'first',displayName:'First',isDefault:true},{model:'second',displayName:'Second',isDefault:false}]);
 await assert.rejects(listCodexModels(path.join(dir,'missing')),/无法启动/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
