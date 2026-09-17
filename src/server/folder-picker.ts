import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);
let choosing=false;
export async function chooseFolder(kind: 'storage'|'export'):Promise<string|null>{
 if(choosing)throw new Error('文件夹选择窗口已打开');
 if(process.platform!=='darwin')throw new Error('当前系统请使用桌面版选择文件夹');
 choosing=true;
 try{
  const prompt=kind==='export'?'选择导出文件夹':'选择数据文件夹';
  const {stdout}=await exec('/usr/bin/osascript',['-e','activate','-e',`POSIX path of (choose folder with prompt "${prompt}")`],{timeout:300000,maxBuffer:8192});
  return stdout.trim()||null;
 }catch(e:any){if(String(e.stderr).includes('(-128)'))return null;throw new Error('未能选择文件夹，请重试');}
 finally{choosing=false;}
}
