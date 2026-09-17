import { chromium, expect } from '@playwright/test';
import { emptyState } from '../dist-server/server/store.js';

const state = emptyState('/tmp/video-controls-fixture');
state.projects = [{ id: 'p', name: '视频参数验收', script: '总剧本', summary: '', createdAt: '' }];
state.episodes = [{ id: 'e', projectId: 'p', name: '第一集', script: '剧本', brief: '', look: '', fullPrompt: '', revision: 1, workflowVersion: 2, createdAt: '', skipImages: true, preparation: { status: 'ready', stage: 'ready', message: '' } }];
state.assets = [{ id: 'a', episodeId: 'e', name: '原片.mp4', kind: 'video', role: 'source', path: '/fixture.mp4', duration: 8, width: 1080, height: 1920, fps: 25, createdAt: '' }];
state.shots = [{ id: 's', episodeId: 'e', assetId: 'a', name: '镜头 1', in: 0, out: 8, scene: '场景', facts: '事实', plan: '计划', imagePrompt: '', videoPrompt: '', referenceIds: [], skipImage: true, confirmed: true, revision: 1 }];
state.segments = [{ id: 'g', episodeId: 'e', name: '生成段 1', clips: [{ id: 'c', shotId: 's', assetId: 'a', in: 0, out: 8 }], prompt: '提示词', mode: 'edit', duration: 8, revision: 1 }];
const commands = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
await page.route('**/api/state', route => route.fulfill({ json: state }));
await page.route('**/api/command', async route => {
  const body = route.request().postDataJSON(); commands.push(body);
  if (body.type === 'segment.update') Object.assign(state.segments[0], body.patch);
  state.revision++;
  await route.fulfill({ json: { state, result: state.segments[0] } });
});
try {
  await page.goto('http://127.0.0.1:5173');
  await page.locator('.parent-project').click();
  await page.locator('.episode-row button').click();
  await page.getByRole('button', { name: '视频制作', exact: true }).click();
  const controls = page.getByLabel('视频生成参数');
  await expect(controls).toBeVisible();
  await expect(controls.getByText('8.00 秒', { exact: true })).toBeVisible();
  await expect(page.getByLabel('输出画面比例')).toBeDisabled();
  await expect(page.getByLabel('输出分辨率')).toHaveValue('source');
  await page.screenshot({ path: 'docs/v2/verification/video-output-controls-edit.png', fullPage: true });
  await page.getByLabel('生成方式').selectOption('reference');
  await expect(page.getByLabel('输出画面比例')).toBeEnabled();
  await page.getByLabel('输出时长').selectOption('12');
  await page.getByLabel('输出画面比例').selectOption('9:16');
  await page.getByLabel('输出分辨率').selectOption('1080p');
  await expect.poll(() => commands.filter(item => item.type === 'segment.update').length).toBe(4);
  await page.screenshot({ path: 'docs/v2/verification/video-output-controls-reference.png', fullPage: true });
  console.log('PASS: edit follows source; reference mode exposes duration, ratio and resolution below output preview. Isolated fixture.');
} finally {
  await browser.close();
}
