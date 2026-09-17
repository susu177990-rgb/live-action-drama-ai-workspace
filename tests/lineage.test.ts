import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import { Store } from '../src/server/store.js';
import { Service } from '../src/server/service.js';
import type { Asset, Episode, Job, Segment, Shot } from '../src/shared/types.js';

const exec = promisify(execFile);
let fixtureDirectory: string;
let sourceVideo: string;

before(async () => {
  fixtureDirectory = await mkdtemp(path.join(tmpdir(), 'workbench-lineage-fixture-'));
  sourceVideo = path.join(fixtureDirectory, 'source.mp4');
  await exec('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=160x90:r=25:d=2', '-f', 'lavfi', '-i', 'color=blue:s=160x90:r=25:d=2', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sourceVideo]);
});

after(async () => { if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true }); });

interface Context { dir: string; store: Store; service: Service; episode: Episode; asset: Asset; shots: Shot[]; segment: Segment }
interface Internals {
  execute(job: Job, signal: AbortSignal): Promise<void>;
  codex(...args: any[]): Promise<{ text: string; images: string[]; json?: unknown }>;
}
const internal = (service: Service) => service as unknown as Internals;
const executeJob = (service: Service, job: Job) => internal(service).execute(job, new AbortController().signal);

async function withWorkspace(run: (context: Context) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-lineage-'));
  const store = await Store.open(dir);
  const service = new Service(store);
  // Explicitly drive individual jobs so tests never invoke a real AI executable or remote provider.
  service.shutdown();
  try {
    const episode = await service.command({ type: 'episode.create', name: '溯源验证集' }) as Episode;
    const asset = await service.addAsset(sourceVideo, episode.id, 'source', '原始实拍.mp4');
    const shots = [service.createShot(episode.id, asset.id, 0, 2), service.createShot(episode.id, asset.id, 2, 4)];
    for (const shot of shots) await service.command({ type: 'shot.update', id: shot.id, patch: { scene: '同一场景', facts: '人工核验静态色板', plan: '保持原有画面', confirmed: true, skipImage: true } });
    const segment = await service.command({ type: 'segment.create', episodeId: episode.id, shotIds: shots.map(shot => shot.id) }) as Segment;
    await run({ dir, store, service, episode, asset, shots, segment });
  } finally {
    service.shutdown();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('rejecting an approved scene look removes every propagated reference and invalidates dependencies', async () => {
  await withWorkspace(async ({ service, episode, shots, segment }) => {
    const frame = await service.command({ type: 'image.capture', shotId: shots[0].id, time: 0.4 }) as Asset;
    await service.import(frame.path, episode.id, 'image-candidate', '候选.png', shots[0].id);
    const take = service.s.takes.at(-1)!;
    const beforeApproval = segment.revision;
    await service.command({ type: 'take.approve', id: take.id, scope: 'look' });
    assert.ok(shots.every(shot => shot.referenceIds.includes(take.assetId)));
    assert.equal(service.asset(take.assetId).role, 'look');
    assert.ok(segment.revision > beforeApproval);
    const beforeRejection = segment.revision;
    await service.command({ type: 'take.reject', id: take.id });
    assert.equal(take.status, 'rejected');
    assert.ok(shots.every(shot => !shot.referenceIds.includes(take.assetId)));
    assert.equal(service.asset(take.assetId).role, 'image-candidate');
    assert.ok(segment.revision > beforeRejection);
    assert.ok(shots.every(shot => !shot.confirmed));
  });
});

test('an older Take retains original order, duration and anchors after its segment is trimmed and reordered', async () => {
  await withWorkspace(async ({ service, episode, asset, shots, segment }) => {
    segment.sourceAssetId = asset.id;
    await service.import(sourceVideo, episode.id, 'video-take', '生成版本.mp4', undefined, segment.id);
    const take = service.s.takes.at(-1)!;
    const originalClips = structuredClone(segment.clips);
    assert.deepEqual(take.sourceClips, originalClips);
    assert.equal(take.sourceAssetId, asset.id);
    await service.command({ type: 'segment.update', id: segment.id, patch: { clips: [{ ...segment.clips[1], out: 3 }, { ...segment.clips[0], out: 1 }] } });
    assert.equal(segment.duration, 2);
    assert.deepEqual(take.sourceClips, originalClips, 'clip snapshot must not alias the mutable segment');
    const alignmentJob = service.s.jobs.find(job => job.type === 'take.autoAlign' && job.targetId === take.id)!;
    await executeJob(service, alignmentJob);
    assert.deepEqual(take.alignments.map(alignment => alignment.shotId), shots.map(shot => shot.id));
    assert.deepEqual(take.alignments.map(alignment => [alignment.sourceIn, alignment.sourceOut]), [[0, 2], [2, 4]]);
    assert.deepEqual(take.alignments[1].anchors, [{ source: 2, generated: 2 }, { source: 4, generated: 4 }]);
    assert.ok(take.alignments.every(alignment => !alignment.confirmed));
    // A valid manual confirmation must use the same historical duration as the automatic proposal.
    await service.command({ type: 'take.align', id: take.id, alignments: take.alignments.map(alignment => ({ ...alignment, confirmed: true })) });
    assert.ok(take.alignments.every(alignment => alignment.confirmed));
  });
});

test('a submitted video request uses frozen reference URLs and provider, not later asset/settings edits', async () => {
  await withWorkspace(async ({ service, asset, shots, segment }) => {
    let submitted: Record<string, any> | undefined;
    const requests: string[] = [];
    const provider = createServer(async (req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/contents/generations/tasks') {
        let body = '';
        for await (const chunk of req) body += chunk;
        submitted = JSON.parse(body);
        res.end(JSON.stringify({ id: 'fixture-task' }));
      } else {
        res.end(JSON.stringify({ status: 'failed', error: { message: 'fixture stops after submission capture' } }));
      }
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const baseURL = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
    try {
      const reference = await service.command({ type: 'image.capture', shotId: shots[0].id, time: 0.5 }) as Asset;
      await service.command({ type: 'asset.update', id: reference.id, patch: { remoteUrl: 'https://media.example.com/original-reference.jpg' } });
      await service.command({ type: 'shot.update', id: shots[0].id, patch: { referenceIds: [reference.id], confirmed: true } });
      await service.command({ type: 'asset.update', id: asset.id, patch: { remoteUrl: 'https://media.example.com/source.mp4' } });
      segment.sourceAssetId = asset.id;
      await service.command({ type: 'settings.update', patch: { apiKey: 'fixture-only-key', apiBaseUrl: baseURL, videoModel: 'fixture-original-model' } });
      const job = await service.command({ type: 'segment.generate', id: segment.id }) as Job;
      await service.command({ type: 'asset.update', id: reference.id, patch: { remoteUrl: 'https://media.example.com/replacement.jpg', name: 'later reference edit' } });
      await service.command({ type: 'settings.update', patch: { apiBaseUrl: 'http://127.0.0.1:1', videoModel: 'later-model' } });
      await assert.rejects(executeJob(service, job), /fixture stops after submission capture/);
      assert.deepEqual(requests, ['POST /contents/generations/tasks', 'GET /contents/generations/tasks/fixture-task']);
      assert.ok(submitted);
      assert.equal(submitted.model, 'fixture-original-model');
      const imageInputs = submitted.content.filter((entry: any) => entry.type === 'image_url');
      assert.deepEqual(imageInputs.map((entry: any) => entry.image_url.url), ['https://media.example.com/original-reference.jpg']);
      assert.equal(job.remoteId, 'fixture-task');
    } finally {
      await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    }
  });
});

test('a queued generation rejects changed shot facts before reaching any provider', async () => {
  await withWorkspace(async ({ service, shots, segment }) => {
    await service.command({ type: 'settings.update', patch: { apiKey: 'fixture-only-key', apiBaseUrl: 'http://127.0.0.1:1', videoModel: 'fixture-model' } });
    const job = await service.command({ type: 'segment.generate', id: segment.id }) as Job;
    await service.command({ type: 'shot.update', id: shots[0].id, patch: { facts: '后来重新核验的事实', confirmed: true } });
    await assert.rejects(executeJob(service, job), /排队期间镜头输入已修改/);
    assert.equal(job.remoteId, undefined);
    assert.equal(job.payload.submissionStarted, undefined);
  });
});

test('the selected captured frame survives persistence and is the first image passed to image generation', async () => {
  await withWorkspace(async ({ dir, service, shots, store }) => {
    const frame = await service.command({ type: 'image.capture', shotId: shots[0].id, time: 0.32 }) as Asset;
    assert.equal(shots[0].sourceFrameId, frame.id);
    assert.equal(shots[0].sourceFrameTime, 0.32);
    assert.ok((await readFile(frame.path)).length > 100);
    await service.command({ type: 'shot.update', id: shots[0].id, patch: { confirmed: true, imagePrompt: '仅用于本地调用参数验证' } });
    let receivedImages: string[] = [];
    internal(service).codex = async (_job, _prompt, images) => { receivedImages = images; return { text: '', images: [] }; };
    const job = await service.command({ type: 'ai.image', shotId: shots[0].id }) as Job;
    await assert.rejects(executeJob(service, job), /未返回可验证的生成图片/);
    assert.equal(receivedImages[0], frame.path, 'selected frame must replace the implicit midpoint');
    store.save();
    const reloaded = await Store.open(dir);
    try {
      const persisted = reloaded.state.shots.find(shot => shot.id === shots[0].id)!;
      assert.equal(persisted.sourceFrameId, frame.id);
      assert.equal(persisted.sourceFrameTime, 0.32);
    } finally { reloaded.close(); }
  });
});

test('a legacy skipped-analysis shot performs just-in-time asset matching before image generation', async () => {
  await withWorkspace(async ({ service, episode, shots }) => {
    const frame = await service.command({ type: 'image.capture', shotId: shots[0].id, time: 0.32 }) as Asset;
    const reference = await service.import(frame.path, episode.id, 'reference', '当前人物服装.png') as Asset;
    await service.command({ type: 'shot.update', id: shots[0].id, patch: { imagePrompt: '跳过分析占位提示词', referenceIds: [], confirmed: false, skipImage: false } });
    delete episode.analysisSkipped;
    delete shots[0].analysisSkipped;
    delete shots[0].automated;
    shots[0].facts = '已跳过 AI 分析；当前仅保留自动切镜结果与实拍首帧。';
    const calls: { images: string[]; schema: any; image: boolean }[] = [];
    internal(service).codex = async (_job, _prompt, images, schema, image) => {
      calls.push({ images, schema, image });
      if (schema?.properties?.referenceIds) return { text: '', images: [], json: { scene: '室内', facts: '保持当前人物与机位', plan: '按参考素材换装', referenceIds: [reference.id], imagePrompt: '使用已关联服装素材改造当前实拍首帧', issues: [] } };
      return { text: '', images: [] };
    };
    const job = await service.command({ type: 'ai.image', shotId: shots[0].id }) as Job;
    await assert.rejects(executeJob(service, job), /未返回可验证的生成图片/);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].image, false);
    assert.ok(calls[0].images.includes(reference.path));
    assert.equal(calls[1].image, true);
    assert.deepEqual(calls[1].images, [frame.path, reference.path]);
    assert.deepEqual(shots[0].referenceIds, [reference.id]);
    assert.equal(shots[0].analysisSkipped, false);
    assert.equal(shots[0].confirmed, true);
    assert.match(shots[0].imagePrompt, /已关联服装素材/);
  });
});

test('direct image generation bypasses skipped-analysis preparation and uses current bindings', async () => {
  await withWorkspace(async ({ service, episode, shots }) => {
    const frame = await service.command({ type: 'image.capture', shotId: shots[0].id, time: 0.32 }) as Asset;
    const reference = await service.import(frame.path, episode.id, 'reference', '手动选择素材.png') as Asset;
    await service.command({ type: 'shot.update', id: shots[0].id, patch: { imagePrompt: '直接测试当前生图链路', referenceIds: [reference.id], confirmed: false, skipImage: false } });
    delete episode.analysisSkipped;
    delete shots[0].analysisSkipped;
    delete shots[0].automated;
    shots[0].facts = '已跳过 AI 分析；当前仅保留自动切镜结果与实拍首帧。';
    const calls: { images: string[]; schema: any; image: boolean }[] = [];
    internal(service).codex = async (_job, _prompt, images, schema, image) => {
      calls.push({ images, schema, image });
      return { text: '', images: [] };
    };
    const job = await service.command({ type: 'ai.image', shotId: shots[0].id, direct: true }) as Job;
    await assert.rejects(executeJob(service, job), /未返回可验证的生成图片/);
    assert.equal(calls.length, 1, 'direct generation must skip the preparation model call');
    assert.equal(calls[0].image, true);
    assert.equal(calls[0].schema, undefined);
    assert.deepEqual(calls[0].images, [frame.path, reference.path]);
    assert.equal(shots[0].confirmed, false, 'a direct test must not claim the shot was analyzed');
  });
});

test('in-flight image prompt output cannot overwrite a later manual edit', async () => {
  await withWorkspace(async ({ service, shots }) => {
    let release!: (value: { text: string; images: string[] }) => void;
    internal(service).codex = () => new Promise(resolve => { release = resolve; });
    const job = await service.command({ type: 'ai.imagePrompt', shotId: shots[0].id }) as Job;
    const pending = executeJob(service, job);
    await service.command({ type: 'shot.update', id: shots[0].id, patch: { imagePrompt: '用户刚刚保存的提示词' } });
    release({ text: '旧输入生成的过时提示词', images: [] });
    await assert.rejects(pending, /未覆盖/);
    assert.equal(shots[0].imagePrompt, '用户刚刚保存的提示词');
  });
});

test('episode prompt output is rejected if a shot changes while AI runs', async () => {
  await withWorkspace(async ({ service, episode, shots }) => {
    episode.fullPrompt = '保留原有整集提示词';
    let release!: (value: { text: string; images: string[] }) => void;
    internal(service).codex = () => new Promise(resolve => { release = resolve; });
    const job = await service.command({ type: 'ai.episodePrompt', episodeId: episode.id }) as Job;
    const pending = executeJob(service, job);
    await service.command({ type: 'shot.update', id: shots[0].id, patch: { facts: '运行期间校正的新事实', confirmed: true } });
    release({ text: '已过时的整集提示词', images: [] });
    await assert.rejects(pending, /未覆盖/);
    assert.equal(episode.fullPrompt, '保留原有整集提示词');
  });
});

test('in-flight revision output cannot replace a newer segment prompt', async () => {
  await withWorkspace(async ({ service, episode, segment }) => {
    await service.import(sourceVideo, episode.id, 'video-take', '待返修版本.mp4', undefined, segment.id);
    const take = service.s.takes.at(-1)!;
    let release!: (value: { text: string; images: string[] }) => void;
    internal(service).codex = () => new Promise(resolve => { release = resolve; });
    const job = await service.command({ type: 'ai.revise', takeId: take.id, feedback: '修正剪辑节奏' }) as Job;
    const pending = executeJob(service, job);
    await service.command({ type: 'segment.update', id: segment.id, patch: { prompt: '用户已经修改的新段提示词' } });
    release({ text: '过时返修结果', images: [] });
    await assert.rejects(pending, /未覆盖/);
    assert.equal(segment.prompt, '用户已经修改的新段提示词');
  });
});
