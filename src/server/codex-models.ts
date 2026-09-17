import { spawn } from 'node:child_process';
export interface CodexModel { model:string; displayName:string; isDefault:boolean }
/** Read the installed Codex app-server catalog; follow every page, including hidden entries. */
export function listCodexModels(cli: string): Promise<CodexModel[]> {
  return new Promise((resolve,reject)=>{
    const child=spawn(cli||'codex',['app-server','--stdio'],{stdio:['pipe','pipe','pipe']});
    let buffer='',settled=false,id=1;
    const models=new Map<string,CodexModel>();const cursors=new Set<string>();
    const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);child.stdin.destroy();child.kill();error?reject(error):resolve([...models.values()]);};
    const timer=setTimeout(()=>finish(new Error('模型列表加载超时，请重试')),30000);
    const send=(method:string,params:any,requestId?:number)=>child.stdin.write(JSON.stringify({method,params,...(requestId===undefined?{}:{id:requestId})})+'\n');
    child.stdin.on('error',()=>{});child.stderr.on('data',()=>{});
    child.on('error',()=>finish(new Error('无法启动 Codex，请检查安装与连接')));
    child.on('close',()=>{if(!settled)finish(new Error('Codex 未返回完整模型列表'));});
    child.stdout.setEncoding('utf8');child.stdout.on('data',(chunk:string)=>{
      buffer+=chunk;const lines=buffer.split('\n');buffer=lines.pop()||'';
      for(const line of lines){if(settled)return;let msg:any;try{msg=JSON.parse(line);}catch{continue;}
        if(msg.id!==id)continue;
        if(msg.error){finish(new Error('Codex 模型列表读取失败，请重新连接后重试'));return;}
        if(id===1){send('initialized',{});send('model/list',{includeHidden:true,limit:100},++id);continue;}
        if(!Array.isArray(msg.result?.data)){finish(new Error('Codex 模型列表格式无效'));return;}
        for(const item of msg.result.data)if(typeof item.model==='string'&&item.model)models.set(item.model,{model:item.model,displayName:item.displayName||item.model,isDefault:!!item.isDefault});
        const cursor=msg.result.nextCursor;
        if(cursor){if(cursors.has(cursor)){finish(new Error('模型列表分页异常'));return;}cursors.add(cursor);send('model/list',{includeHidden:true,limit:100,cursor},++id);}
        else finish(models.size?undefined:new Error('当前 Codex 未返回可用模型'));
      }
    });
    send('initialize',{clientInfo:{name:'yuguang_workbench',version:'2.0.0'},capabilities:null},id);
  });
}
