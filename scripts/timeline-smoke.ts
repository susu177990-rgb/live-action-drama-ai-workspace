import { chromium, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startServer } from '../src/server/index.js';

const evidence = JSON.parse(await readFile('docs/verification/media-smoke.json', 'utf8'));
if (!evidence.dataDir.includes('/verification-')) throw new Error('Refusing to modify non-verification data');
const runtime = await startServer({ dataDir: evidence.dataDir, port: 4319, staticDir: path.resolve('dist') });
const initialSegment = structuredClone(runtime.store.state.segments.find(s => s.id === evidence.segmentId)!);
const initialEpisode = structuredClone(runtime.store.state.episodes.find(e => e.id === initialSegment.episodeId)!);
const initialTake = structuredClone(runtime.store.state.takes.find(t => t.id === evidence.takeId)!);
const segment = () => runtime.store.state.segments.find(s => s.id === evidence.segmentId)!;
const take = () => runtime.store.state.takes.find(t => t.id === evidence.takeId)!;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
page.setDefaultTimeout(15000);
const errors: string[] = [], apiErrors: string[] = [], checked: string[] = [];
page.on('pageerror', e => errors.push(e.message));
page.on('response', response => { if (response.status() >= 400 && /\/api\//.test(response.url())) apiErrors.push(`${response.status()} ${response.url()}`); });
try {
  assert(initialSegment?.clips.length, 'Verification segment is required');
  await page.goto(runtime.url);
  await page.getByRole('button', { name: '设置', exact: true }).waitFor();
  await page.locator('.episode-row').filter({hasText: runtime.store.state.episodes.find(e=>e.id===initialSegment.episodeId)!.name}).getByRole('button',{name:/继续制作/}).click();
  const videoNav=page.getByRole('button',{name:'视频制作',exact:true});
  await videoNav.click();
  const skipConfirm = page.getByRole('button', { name: '确认跳过并进入', exact: true });
  if (await skipConfirm.isVisible()) await skipConfirm.click();
  await page.locator('.segment-item').filter({ hasText: initialSegment.name }).click();
  const timeline = page.locator('.timeline');
  const firstClip = page.locator('.timeline-clip').first();
  await firstClip.click({ position: { x: 110, y: 35 } });
  await timeline.getByRole('button', { name: /拆分/ }).click();
  await expect.poll(() => segment().clips.length).toBe(initialSegment.clips.length + 1);
  const splitIds = segment().clips.map(c => c.id);
  assert(Math.abs(segment().duration - initialSegment.duration) < .00001);
  checked.push('时间轴播放头拆分，片段数量增加、总时长保持');

  await page.locator('.timeline-clip').first().dragTo(page.locator('.timeline-clip').nth(1));
  await expect.poll(() => segment().clips[0]?.id).toBe(splitIds[1]);
  checked.push('拖动镜头重排并保存');
  await timeline.getByRole('button', { name: /撤销/ }).click();
  await expect.poll(() => segment().clips[0]?.id).toBe(splitIds[0]);
  await timeline.getByRole('button', { name: /撤销/ }).click();
  await expect.poll(() => segment().clips.length).toBe(initialSegment.clips.length);
  assert.deepEqual(segment().clips, initialSegment.clips);
  checked.push('重排撤销与拆分撤销还原原始时间轴');

  await page.locator('.timeline-clip').first().click({ position: { x: 20, y: 30 } });
  const newIn = initialSegment.clips[0]!.in + .25;
  await timeline.getByLabel('入点 s', { exact: true }).fill(String(newIn));
  await timeline.getByLabel('入点 s', { exact: true }).press('Tab');
  await expect.poll(() => segment().clips[0]!.in).toBe(newIn);
  await timeline.getByRole('button', { name: /撤销/ }).click();
  await expect.poll(() => segment().clips[0]!.in).toBe(initialSegment.clips[0]!.in);
  checked.push('数字入点裁剪保存与撤销');

  await page.getByText('逐镜对齐与映射',{exact:true}).click();
  const firstMapping = page.locator('.alignment').first();
  await firstMapping.waitFor();
  const oldMapping = structuredClone(take().alignments[0]!);
  const generatedOut = oldMapping.generatedOut - Math.min(.2, (oldMapping.generatedOut - oldMapping.generatedIn) / 4);
  await firstMapping.getByLabel('生成出点 s', { exact: true }).fill(String(generatedOut));
  await firstMapping.getByLabel('生成出点 s', { exact: true }).press('Tab');
  await expect.poll(() => take().alignments[0]!.generatedOut).toBe(generatedOut);
  assert(take().alignments[0]!.anchors.every(a => a.generated <= generatedOut));
  await firstMapping.getByRole('button', { name: '确认映射', exact: true }).click();
  await expect.poll(() => take().alignments[0]!.confirmed).toBe(true);
  checked.push('手动映射边界编辑、端点锚点跟随、确认持久化');

  const anchorCount = take().alignments[0]!.anchors.length;
  await firstMapping.getByRole('button', { name: /＋ 锚点/ }).click();
  await expect.poll(() => take().alignments[0]!.anchors.length).toBe(anchorCount + 1);
  const anchors = take().alignments[0]!.anchors;
  assert(anchors.every((anchor, index) => index === 0 || (anchor.source > anchors[index - 1]!.source && anchor.generated > anchors[index - 1]!.generated)));
  checked.push('新增锚点按时间严格递增保存');

  await page.getByRole('button', { name: '审片与批注',exact:true }).first().click();
  const asset = runtime.store.state.assets.find(a => a.id === take().assetId)!;
  const outputIn = .25, outputOut = (asset.duration || 6) - .25;
  await page.getByLabel('成片入点 / 秒', { exact: true }).fill(String(outputIn));
  await page.getByLabel('成片入点 / 秒', { exact: true }).press('Tab');
  await expect.poll(() => take().exportIn).toBe(outputIn);
  await page.getByLabel('成片出点 / 秒', { exact: true }).fill(String(outputOut));
  await page.getByLabel('成片出点 / 秒', { exact: true }).press('Tab');
  await expect.poll(() => take().exportOut).toBe(outputOut);
  checked.push('成片入点/出点经 take.trim API 保存');

  await page.reload();
  await page.locator('.episode-row').filter({hasText: runtime.store.state.episodes.find(e=>e.id===initialSegment.episodeId)!.name}).getByRole('button',{name:/继续制作/}).click();
  await page.getByRole('button',{name:'视频制作',exact:true}).click();
  await page.locator('.segment-item').filter({ hasText: initialSegment.name }).click();
  await page.getByRole('button', { name: '审片与批注',exact:true }).first().click();
  await expect(page.getByLabel('成片入点 / 秒', { exact: true })).toHaveValue(String(outputIn));
  await expect(page.getByLabel('成片出点 / 秒', { exact: true })).toHaveValue(String(outputOut));
  checked.push('重载后裁剪和镜头状态恢复');
  await expect(page.locator('.inline-error')).toHaveCount(0);
  assert.deepEqual(errors, []); assert.deepEqual(apiErrors, []);
  await page.screenshot({ path: 'docs/verification/timeline-review.png', fullPage: true });
  await writeFile('docs/verification/timeline-smoke.json', JSON.stringify({ passed: true, checked, errors, apiErrors, source: evidence.source, dataDir: evidence.dataDir, note: '仅在已有真实媒体验收数据内操作；无 AI 调用。结束后还原验收片段和 Take。' }, null, 2));
  console.log('Timeline browser checks passed:', checked.join('；'));
} catch (error) {
  await page.screenshot({ path: 'docs/verification/timeline-failure.png', fullPage: true });
  console.log(await page.locator('body').innerText());
  throw error;
} finally {
  // Restore only the two verification fixture objects after the browser exercise.
  const segmentIndex = runtime.store.state.segments.findIndex(s => s.id === initialSegment.id);
  const takeIndex = runtime.store.state.takes.findIndex(t => t.id === initialTake.id);
  runtime.store.state.segments[segmentIndex] = initialSegment;
  runtime.store.state.takes[takeIndex] = initialTake;
  runtime.store.state.episodes[runtime.store.state.episodes.findIndex(e => e.id === initialEpisode.id)] = initialEpisode;
  runtime.store.save();
  await browser.close();
  await runtime.close();
}
