import { chromium, expect } from '@playwright/test';
import { emptyState } from '../dist-server/server/store.js';
import assert from 'node:assert/strict';
// Isolated UI fixture: no analysis or production-data writes.
const state=emptyState('/tmp/preparation-ui-fixture');
state.projects=[{id:'p',name:'暂停与状态验收',script:'总剧本',summary:'已分集',createdAt:''}];
state.episodes=[{id:'e',projectId:'p',name:'第一集',script:'剧本',brief:'',look:'',fullPrompt:'',revision:1,workflowVersion:2,createdAt:'',skipImages:false,preparation:{status:'running',stage:'materials',message:'正在理解剧本、原片样本与上传资产',jobId:'j'}}];
state.jobs=[{id:'j',episodeId:'e',targetId:'e',type:'episode.prepare',status:'running',progress:.02,message:'Codex：Reconnecting... 5/5 (request timed out)',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),payload:{}}];
const calls=[];
const browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1440,height:1100}});
await page.route('**/api/state',r=>r.fulfill({json:state}));
await page.route('**/api/command',async r=>{
 const body=r.request().postDataJSON();calls.push(body.type);
 assert(['preparation.pause','preparation.resume'].includes(body.type));
 state.jobs[0].status=body.type==='preparation.pause'?'paused':'running';
 state.jobs[0].message=body.type==='preparation.pause'?'已暂停；已完成步骤已保存':'Codex 请求已开始，等待分析输出';
 state.episodes[0].preparation.status=state.jobs[0].status;state.revision++;
 await r.fulfill({json:{ok:true}});
});
try{
 await page.goto('http://127.0.0.1:5173');await page.locator('.parent-project').click();await page.locator('.episode-row button').click();
 await expect(page.getByRole('status')).toContainText('Reconnecting... 5/5 (request timed out)');
 const bar=await page.locator('.prepare-page progress').boundingBox(),log=await page.getByRole('status').boundingBox();assert(log.y>=bar.y+bar.height);
 await page.screenshot({path:'docs/v2/verification/preparation-live-status.png',fullPage:true});
 await page.getByRole('button',{name:'暂停分析',exact:true}).click();await expect(page.getByRole('heading',{name:'分析已暂停'})).toBeVisible();
 await page.screenshot({path:'docs/v2/verification/preparation-paused.png',fullPage:true});
 await page.reload();await page.locator('.parent-project').click();await page.locator('.episode-row button').click();
 await expect(page.getByRole('button',{name:'恢复分析',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'恢复分析',exact:true}).click();await expect(page.getByRole('button',{name:'暂停分析',exact:true})).toBeVisible();
 assert.deepEqual(calls,['preparation.pause','preparation.resume']);console.log('PASS: real-status line position, timeout text, pause/resume controls, paused re-entry (isolated fixture)');
}finally{await browser.close();}
