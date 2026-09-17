import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname } from 'node:path';
import type { Settings, CodexRequest } from '../../shared/types.js';
import { validateRemoteMediaURL } from './seedance.js';
import { networkFetch } from '../network.js';

const mime: Record<string,string> = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp' };
const endpointURL = (base: string, endpoint: string) => {
  const url = new URL(base);
  const path = url.pathname.replace(/\/+$/, '');
  if (!path.endsWith(endpoint)) url.pathname = path + endpoint;
  return url.toString();
};
export async function runCustomAI(settings: Settings, request: CodexRequest) {
  const key = request.image ? settings.imageApiKey : settings.llmApiKey;
  const base = (request.image ? settings.imageApiBaseUrl : settings.llmApiBaseUrl).replace(/\/+$/, '');
  const model = request.image ? settings.imageApiModel : settings.llmApiModel;
  if (!base || !model) throw new Error('请填写自定义 API 的完整 Base URL 和模型名称');
  const signal = request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000);
  // OpenAI-compatible services normally use Bearer auth; some compatible
  // gateways (including CRUN) require X-API-KEY instead. Sending both keeps
  // the generic mode usable without adding provider-specific settings.
  const headers: Record<string,string> = key ? { Authorization: `Bearer ${key}`, 'X-API-KEY': key } : {};
  await mkdir(dirname(request.outputPath), {recursive:true});
  request.onEvent?.({type:'status',message:`自定义${request.image ? '生图' : 'LLM'} API：正在提交请求`});
  try {
    let endpoint: string, body: string | FormData;
    if (request.image && request.images?.length) {
      endpoint='/images/edits';
      const form=new FormData(); form.set('model',model);form.set('prompt',request.prompt);form.set('n','1');
      for(const file of request.images) {
        const type=mime[extname(file).toLowerCase()]; if(!type) throw new Error('自定义生图仅支持 PNG、JPEG、WebP 输入');
        form.append('image[]',new Blob([await readFile(file)],{type}),basename(file));
      }
      body=form;
    } else if(request.image) {
      endpoint='/images/generations';headers['Content-Type']='application/json';body=JSON.stringify({model,prompt:request.prompt,n:1});
    } else {
      endpoint='/chat/completions';headers['Content-Type']='application/json';
      const content:any[]=[{type:'text',text:request.prompt}];
      for(const file of request.images||[]) {
        const type=mime[extname(file).toLowerCase()];if(!type)throw new Error('自定义 LLM 图片输入仅支持 PNG、JPEG、WebP');
        content.push({type:'image_url',image_url:{url:`data:${type};base64,${(await readFile(file)).toString('base64')}`}});
      }
      body=JSON.stringify({model,messages:[{role:'user',content}],...(request.schema ? {response_format:{type:'json_schema',json_schema:{name:'workbench_result',strict:true,schema:request.schema}}} : {})});
    }
    const response=await networkFetch(endpointURL(base,endpoint),{method:'POST',headers,body,signal,redirect:'error'});
    const raw=await response.text();let data:any;
    try {data=JSON.parse(raw);}catch {throw new Error(`API 返回非 JSON（HTTP ${response.status}）`);}
    if(!response.ok)throw new Error(`API HTTP ${response.status}：${String(data.error?.message||data.message||'请求失败').slice(0,700)}`);
    request.onEvent?.({type:'status',message:'自定义 API 已响应，正在校验结果'});
    if(request.image) {
      const item=data.data?.[0];let bytes:Buffer;
      if(item?.b64_json)bytes=Buffer.from(item.b64_json,'base64');
      else if(item?.url){validateRemoteMediaURL(item.url);const download=await networkFetch(item.url,{signal,redirect:'error'});if(!download.ok)throw new Error(`下载生成图失败（HTTP ${download.status}）`);bytes=Buffer.from(await download.arrayBuffer());}
      else throw new Error('生图 API 未返回实际图片（data[0].b64_json 或 url）');
      const ext=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? '.png' : bytes[0]===255&&bytes[1]===216&&bytes[2]===255 ? '.jpg' : bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP' ? '.webp' : '';
      if(!ext)throw new Error('生图 API 返回的文件不是有效图片格式');
      const file=request.outputPath+ext;await writeFile(file,bytes,{flag:'wx'});
      const text=JSON.stringify({status:'generated',image_path:file});await writeFile(request.outputPath,text,{flag:'wx'});
      return {text,json:JSON.parse(text),images:[file],threadId:undefined};
    }
    const text=data.choices?.[0]?.message?.content;
    if(typeof text!=='string'||!text.trim())throw new Error('LLM API 未返回有效文本');
    await writeFile(request.outputPath,text,{flag:'wx'});
    let json:any;if(request.schema){try{json=JSON.parse(text);}catch{throw new Error('LLM API 未返回有效结构化 JSON');}}
    return {text,json,images:[] as string[],threadId:undefined};
  }catch(error){
    const cause = error instanceof Error ? (error as Error & { cause?: { code?: string; message?: string } }).cause : undefined;
    let message=error instanceof Error?error.message:String(error);
    if (cause?.code === 'UND_ERR_CONNECT_TIMEOUT') message = `无法连接 API 服务器：连接超时（${new URL(base).host}）`;
    else if (message === 'fetch failed' && cause?.message) message = `无法连接 API 服务器：${cause.message}`;
    if(key)message=message.split(key).join('[REDACTED]');
    throw new Error(signal.aborted?'请求已停止或超时；未自动重试':message);
  }
}
