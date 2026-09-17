import { chromium, expect } from '@playwright/test';
import { emptyState } from '../dist-server/server/store.js';
import assert from 'node:assert/strict';
const state=emptyState('/tmp/ui-fixture-only');
state.projects=[{id:'p',name:'画面要求分层预览',script:'总剧本',summary:'分集完成',createdAt:'',visualStyle:'电影写实质感',visualBrief:'保留实拍表演'}];
state.episodes=[{id:'e',projectId:'p',name:'第一集',script:'本集剧本\n'.repeat(60),brief:'',look:'夜景',sceneLooks:{教堂:'暖色烛光'},fullPrompt:'',revision:1,workflowVersion:2,createdAt:'',skipImages:false}];
state.assets=[{id:'a',episodeId:'e',name:'原片.mp4',kind:'video',role:'source',createdAt:'',path:'/fixture.mp4'}];
const browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1536,height:1000}});
await page.route('**/api/state',r=>r.fulfill({json:state}));
await page.route('**/api/command',r=>r.fulfill({status:400,json:{error:'隔离布局验收禁止修改真实数据'}}));
await page.route('**/api/thumbnail**',r=>r.fulfill({status:204}));
try {
 await page.goto('http://127.0.0.1:5173');await page.locator('.parent-project').click();
 await expect(page.getByRole('textbox',{name:'统一画面风格与质感',exact:true})).toHaveValue('电影写实质感');
 await expect(page.getByRole('textbox',{name:'统一画面改造要求',exact:true})).toHaveCount(0);
 await page.locator('.episode-row button').click();
 const boxes=await page.locator('.upload-grid>.upload-zone').evaluateAll(es=>es.map(e=>({height:e.getBoundingClientRect().height,y:e.getBoundingClientRect().y})));
 assert.equal(boxes.length,3);assert(boxes.every(b=>b.height===boxes[0].height&&b.y===boxes[0].y));
 await expect(page.getByText('补充制作要求（可选）',{exact:true})).toHaveCount(0);
 await page.screenshot({path:'docs/v2/verification/aligned-material-columns.png',fullPage:true});
 state.episodes[0].preparation={status:'ready',stage:'ready',message:''};state.shots=[{id:'s',episodeId:'e',assetId:'a',name:'镜头 1',in:0,out:4,scene:'教堂',facts:'事实',plan:'规划',requirements:'替换背景',imagePrompt:'提示词',videoPrompt:'视频词',referenceIds:[],skipImage:false,confirmed:true,revision:1}];state.revision++;
 await page.reload();await page.locator('.parent-project').click();await page.locator('.episode-row button').click();
 await page.getByRole('button',{name:'本集 / 场景光影',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'场景「教堂」影调与光影',exact:true})).toHaveValue('暖色烛光');
 await page.getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('button',{name:'查看 镜头 1',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'镜头 1 · 独立画面要求',exact:true})).toHaveValue('替换背景');
 console.log('通过：三栏等高、上传页无制作要求、大项目/场景/镜头编辑入口；隔离页面数据。');
}finally {await browser.close();}
