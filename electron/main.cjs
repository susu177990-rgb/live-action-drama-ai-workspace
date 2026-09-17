const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
let runtime;
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance',()=>{const w=BrowserWindow.getAllWindows()[0];if(w){w.restore();w.focus();}});
app.whenReady().then(async()=>{
  try {
    const { startServer } = await import(pathToFileURL(path.join(__dirname,'../dist-server/server/index.js')).href);
    runtime=await startServer({dataDir:process.env.WORKBENCH_DATA_DIR||path.join(__dirname,'../.workbench'),staticDir:path.join(__dirname,'../dist'),chooseFolder:async(kind)=>{const picked=await dialog.showOpenDialog({title:kind==='export'?'选择导出文件夹':'选择数据文件夹',properties:['openDirectory','createDirectory']});return picked.canceled?null:picked.filePaths[0]||null;}});
    const win=new BrowserWindow({width:1560,height:1000,minWidth:1100,minHeight:760,backgroundColor:'#111318',title:'与光 · 实拍工作台',webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
    win.webContents.setWindowOpenHandler(({url})=>{if(url.startsWith(runtime.url+'/media/'))shell.openExternal(url);return{action:'deny'};});
    win.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==runtime.url)event.preventDefault();});
    win.webContents.session.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
    await win.loadURL(runtime.url);
  }catch(error){dialog.showErrorBox('工作台启动失败',error.message+'\n请先运行 npm run build，并关闭已占用数据目录的工作台。');app.quit();}
});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>{if(runtime)void runtime.close();});
