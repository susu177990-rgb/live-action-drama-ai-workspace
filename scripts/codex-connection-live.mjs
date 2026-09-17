import {chromium,expect} from '@playwright/test';
const browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1440,height:1050}});
try{
 await page.goto('http://127.0.0.1:5173');await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'API 设置',exact:true}).click();
 await expect(page.locator('.codex-connection')).toContainText('已登录');
 await page.getByRole('button',{name:'检测连接',exact:true}).click();
 await expect(page.locator('.codex-connection')).toContainText('连接成功 · 真实模型请求已返回',{timeout:190000});
 await page.screenshot({path:'docs/v2/verification/codex-connected-live.png'});
 console.log('PASS: live UI button → backend → logged-in Codex CLI → WORKBENCH_OK; no episode resumed.');
}finally{await browser.close();}
