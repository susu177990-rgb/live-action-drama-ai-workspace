import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Settings } from '../shared/types.js';
import { checkCodex, runCodex } from './ai.js';

export class CodexConnection {
  state = { status:'idle', message:'尚未连接', authenticated:false, imageAvailable:false, version:'', loginUrl:'', checkedAt:'' };
  private controller?: AbortController;
  reset() {
    if(this.controller)throw new Error('请先停止 Codex 连接测试，再修改 Codex 配置');
    this.state={status:'idle',message:'配置已更新，请重新检测连接',authenticated:false,imageAvailable:false,version:'',loginUrl:'',checkedAt:''};
  }
  async inspect(settings: Settings) {
    if(this.controller)return {...this.state};
    const info=await checkCodex(settings);
    this.state={...this.state,authenticated:info.authenticated,imageAvailable:info.imageAvailable,version:info.version};
    if(!info.authenticated){this.state.status='idle';this.state.message='尚未登录 Codex';}
    return {...this.state};
  }
  connect(settings: Settings) {
    if(this.controller)return {...this.state};
    const controller=this.controller=new AbortController();
    this.state={...this.state,status:'connecting',message:'正在检查 Codex 登录',loginUrl:''};
    void this.run({...settings},controller).finally(()=>{if(this.controller===controller)this.controller=undefined;});
    return {...this.state};
  }
  cancel(){this.controller?.abort();}
  private async run(settings: Settings,controller:AbortController){
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(180000)]);
    try{
      const info=await checkCodex(settings);signal.throwIfAborted();
      this.state={...this.state,authenticated:info.authenticated,imageAvailable:info.imageAvailable,version:info.version};
      if(!info.authenticated){
        this.state.status='waiting_login';this.state.message='请在打开的浏览器中完成 Codex 登录';
        await new Promise<void>((resolve,reject)=>{
          const child=spawn(settings.codexPath||'codex',['login'],{stdio:['ignore','pipe','pipe'],signal});
          let output='';
          const consume=(chunk:Buffer)=>{
            output=(output+chunk.toString()).slice(-16000);
            const match=output.match(/https:\/\/auth\.openai\.com\/[^\s\u001b]+/);
            if(match)this.state.loginUrl=match[0];
          };
          child.stdout.on('data',consume);child.stderr.on('data',consume);
          child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error(`Codex 登录未完成（退出码 ${code}），请重试`)));
        });
        const verified=await checkCodex(settings);if(!verified.authenticated)throw new Error('登录尚未完成');
        this.state.authenticated=true;
      }
      this.state.loginUrl='';this.state.status='testing';this.state.message='已登录，正在发送真实模型连接测试';
      const cwd=path.join(settings.dataDir,'connection-checks');
      const result=await runCodex(settings,{prompt:'连接测试。不要调用工具或读取文件。仅回复 WORKBENCH_OK。',cwd,outputPath:path.join(cwd,`${Date.now()}.txt`),signal,onEvent:e=>{if(e.type==='error'||e.type==='turn.failed')this.state.message=String(e.message||e.error?.message||'连接失败');}});
      if(result.text.trim()!=='WORKBENCH_OK')throw new Error('模型返回了响应，但连接测试内容不符合预期');
      this.state.status='connected';this.state.message='连接成功 · 真实模型请求已返回';
    }catch(error){this.state.status=controller.signal.aborted?'idle':'failed';this.state.message=controller.signal.aborted?'连接测试已停止':signal.aborted?'连接超时，请检查网络后重试':String(error instanceof Error?error.message:error).slice(-1000);}
    finally{this.state.checkedAt=new Date().toISOString();this.state.loginUrl='';}
  }
}
