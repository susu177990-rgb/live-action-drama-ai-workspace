// macOS fallback installer: verify the binary against checksums shipped by Electron.
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto'), {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'), pkg=path.join(root,'node_modules/electron');
const binary=path.join(pkg,'dist/Electron.app/Contents/MacOS/Electron');
if(fs.existsSync(binary))process.exit(0);
if(process.platform!=='darwin')throw new Error('请运行 node node_modules/electron/install.js 安装当前平台运行时');
const version=JSON.parse(fs.readFileSync(path.join(pkg,'package.json'))).version;
const archive=`electron-v${version}-darwin-${process.arch}.zip`;
const folder=path.join(root,'.workbench/downloads');fs.mkdirSync(folder,{recursive:true});const file=path.join(folder,archive);
const checksums=JSON.parse(fs.readFileSync(path.join(pkg,'checksums.json')));
const valid=()=>fs.existsSync(file)&&crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')===checksums[archive];
if(!valid())execFileSync('curl',['--http1.1','-fL','--retry-all-errors','--retry','3','--retry-delay','2','--max-time','240','-o',file,`https://github.com/electron/electron/releases/download/v${version}/${archive}`],{stdio:'inherit'});
if(!valid())throw new Error('Electron 下载校验失败，未安装运行时');
fs.mkdirSync(path.join(pkg,'dist'),{recursive:true});execFileSync('/usr/bin/ditto',['-x','-k',file,path.join(pkg,'dist')]);
fs.writeFileSync(path.join(pkg,'path.txt'),'Electron.app/Contents/MacOS/Electron');
console.log('Electron 运行时 SHA-256 校验及安装通过');
