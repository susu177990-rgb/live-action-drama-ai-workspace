import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dataDir = await mkdtemp(path.join(tmpdir(), 'workbench-desktop-'));
const app = await electron.launch({args: ['.'], env: {...process.env, WORKBENCH_DATA_DIR: dataDir}});
try {
  const page = await app.firstWindow();
  await expect(page.locator('.page-projects')).toBeVisible();
  await expect(page.locator('.timeline')).toHaveCount(0);
  const health = await page.evaluate(async () => (await fetch('/api/health')).json());
  if (health.version !== '2.0.0') throw new Error('Wrong server version');
  await page.screenshot({path: 'docs/v2/verification/desktop.png'});
  await writeFile('docs/v2/verification/desktop.json', JSON.stringify({passed:true,health,checked:['Electron真实启动','项目首页','前后端版本2.0.0'],date:new Date().toISOString()},null,2));
  console.log('Desktop V2 startup passed.');
} finally {await app.close();await rm(dataDir,{recursive:true,force:true});}
