import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { Store, defaultSettings } from '../src/server/store.js';
import { Service } from '../src/server/service.js';
import type { Job, Segment } from '../src/shared/types.js';

// This is a non-live orchestration test. Only a loopback HTTP fixture and real
// ffmpeg/ffprobe are used; it never contacts Codex or a video-generation account.
const exec = promisify(execFile);
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw new Error(`等待超时：${label}`); await wait(20); }
}
async function idle(service: Service) {
  await until(() => !service.s.jobs.some(job => ['queued', 'running'].includes(job.status)), '本地任务完成');
}

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-video-job-'));
  const config = defaultSettings(dir); const sourcePath = path.join(dir, 'synthetic-source.mp4');
  const imagePath = path.join(dir, 'synthetic-frame.png');
  await exec(config.ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=320x180:r=25:d=2', '-f', 'lavfi', '-i', 'color=blue:s=320x180:r=25:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath]);
  await exec(config.ffmpegPath, ['-v', 'error', '-i', sourcePath, '-frames:v', '1', imagePath]);
  const videoBytes = await readFile(sourcePath);
  const calls = { uploads: 0, creates: 0, polls: 0, downloads: 0, uploadedBytes: 0, payloads: [] as any[] };
  const behavior = { createStatus: 200, holdFirstPoll: false, firstPollResponse: undefined as ServerResponse | undefined };
  let base = '';
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/generated.mp4') {
        calls.downloads++; res.setHeader('Content-Type', 'video/mp4'); res.setHeader('Content-Length', String(videoBytes.length)); res.end(videoBytes); return;
      }
      assert.equal(req.headers.authorization, 'Bearer fixture-key-not-live');
      let body = Buffer.alloc(0); for await (const part of req) body = Buffer.concat([body, part]);
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/api/v3/files') {
        calls.uploads++; calls.uploadedBytes += body.length;
        assert.match(req.headers['content-type'] || '', /^multipart\/form-data/);
        assert.match(body.toString('latin1'), /name="purpose"\r\n\r\nuser_data/);
        res.end(JSON.stringify({ id: 'fixture-file', status: 'active', download_url: 'https://fixture.invalid/source.mp4?signature=fixture-only' }));
      } else if (req.method === 'POST' && req.url === '/api/v3/contents/generations/tasks') {
        calls.creates++; calls.payloads.push(JSON.parse(body.toString())); res.statusCode = behavior.createStatus;
        res.end(JSON.stringify(behavior.createStatus === 200 ? { id: 'fixture-remote-task' } : { error: { message: 'non-live create failure' } }));
      } else if (req.method === 'GET' && /^\/api\/v3\/contents\/generations\/tasks\//.test(req.url || '')) {
        calls.polls++;
        if (behavior.holdFirstPoll && calls.polls === 1) { behavior.firstPollResponse = res; return; }
        res.end(JSON.stringify({ id: 'fixture-remote-task', status: 'succeeded', content: { video_url: `${base}/generated.mp4` } }));
      } else { res.statusCode = 404; res.end(JSON.stringify({ error: { message: 'unexpected fixture route' } })); }
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: { message: String(error) } })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let store = await Store.open(dir); let service = new Service(store);
  await service.command({ type: 'settings.update', patch: { apiBaseUrl: `${base}/api/v3`, uploadBaseUrl: `${base}/api/v3`, apiKey: 'fixture-key-not-live', videoModel: 'fixture-model-never-submitted-live' } });
  const episode = await service.command({ type: 'episode.create', name: '非线上视频服务联调' });
  const source = await service.import(sourcePath, episode.id, 'source', '实拍源片.mp4'); await idle(service);
  const first = service.s.shots[0];
  await service.command({ type: 'shot.update', id: first.id, patch: { out: 2, facts: '红色纯背景，无人物', scene: '红色', plan: '保持机位', confirmed: true } });
  const second = await service.command({ type: 'shot.create', episodeId: episode.id, assetId: source.id, in: 2, out: 4 });
  await service.command({ type: 'shot.update', id: second.id, patch: { facts: '蓝色纯背景，无人物', scene: '蓝色', plan: '保持机位', confirmed: true } });
  const segment: Segment = await service.command({ type: 'segment.create', episodeId: episode.id, shotIds: [first.id, second.id] });
  return {
    dir, calls, behavior, videoBytes, imagePath, base, episode, first, second, segment,
    get service() { return service; },
    async reopen() { service.shutdown(); store.close(); store = await Store.open(dir); service = new Service(store); return service; },
    async close() { behavior.firstPollResponse?.destroy(); service.shutdown(); await idle(service); store.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); },
  };
}

test('non-live remote job: approved image binding, upload once, download real MP4, snapshot and automatic alignment', { timeout: 35_000 }, async () => {
  const f = await fixture(); const s = f.service;
  try {
    // The public command refuses paid generation before each required image is approved.
    await assert.rejects(s.command({ type: 'segment.generate', id: f.segment.id }), /批准分镜/);
    assert.equal(f.calls.creates, 0); assert.equal(f.calls.uploads, 0);
    for (const shot of [f.first, f.second]) {
      await s.import(f.imagePath, f.episode.id, 'image-candidate', `${shot.scene}候选.png`, shot.id);
      const take = s.s.takes.find(item => item.shotId === shot.id)!;
      await assert.rejects(s.command({ type: 'segment.generate', id: f.segment.id }), /批准分镜/);
      await s.command({ type: 'take.approve', id: take.id });
    }
    const originalClips = structuredClone(f.segment.clips); const originalRevision = f.segment.revision;
    const originalPrompt = f.segment.prompt; f.behavior.holdFirstPoll = true;
    const job: Job = await s.command({ type: 'segment.generate', id: f.segment.id });
    await until(() => Boolean(f.behavior.firstPollResponse), '远端首次查询');
    assert.equal(f.calls.uploads, 1); assert(f.calls.uploadedBytes > 1000); assert.equal(f.calls.creates, 1);
    const request = f.calls.payloads[0]; assert.equal(request.omni_reference_task_type, 'edit'); assert.equal(request.duration, -1); assert.equal(request.ratio, 'adaptive'); assert.equal(request.resolution, '480p'); assert.equal(request.generate_audio, true);
    assert.match(request.content[0].text, /@Video 1 = "原视频"/); assert.match(request.content[0].text, /@Image 1 = /); assert.match(request.content[0].text, /@Image 2 = /);
    assert.equal(request.content.filter((item: any) => item.role === 'reference_image').length, 2);
    assert.match(request.content.find((item: any) => item.role === 'reference_video').video_url.url, /^https:\/\/fixture\.invalid\//);
    // A later edit must not retroactively change the source cuts of the returned Take.
    await s.command({ type: 'segment.update', id: f.segment.id, patch: { clips: [...f.segment.clips].reverse(), prompt: '任务提交后的新提示词' } });
    f.behavior.firstPollResponse!.end(JSON.stringify({ id: 'fixture-remote-task', status: 'succeeded', content: { video_url: `${f.base}/generated.mp4` } }));
    await idle(s); assert.equal(job.status, 'succeeded', job.error || ''); assert.equal(job.remoteId, 'fixture-remote-task');
    assert.equal(f.calls.creates, 1); assert.equal(f.calls.polls, 1); assert.equal(f.calls.downloads, 1);
    const take = s.take(job.resultId); assert.equal(take.kind, 'video'); assert.equal(take.status, 'candidate');
    assert.deepEqual(take.sourceClips, originalClips); assert.equal(take.sourceRevision, originalRevision); assert.equal(take.prompt, originalPrompt);
    assert(take.sourceAssetId); assert.equal(s.asset(take.sourceAssetId).role, 'assembled-source');
    assert.match(s.asset(take.sourceAssetId).remoteUrl || '', /fixture\.invalid/);
    assert.deepEqual(await readFile(s.asset(take.assetId).path), f.videoBytes);
    assert.deepEqual(take.alignments.map(item => item.shotId), [f.first.id, f.second.id]);
    assert.equal(take.alignments[0].sourceIn, 0); assert.equal(take.alignments[1].sourceIn, 2);
    assert(take.alignments.every(item => !item.confirmed)); assert.equal(f.segment.selectedTakeId, undefined);
    assert.doesNotMatch(JSON.stringify(job.payload.request), /signature=fixture-only|data:image\/png;base64/);
    const alignmentJob: Job = await s.command({ type: 'take.autoAlign', id: take.id }); await idle(s);
    assert.equal(alignmentJob.status, 'succeeded', alignmentJob.error || ''); assert.deepEqual(take.alignments.map(item => item.shotId), [f.first.id, f.second.id]);
  } finally { await f.close(); }
});

test('non-live remote failure: unknown submit persists and resumes by task ID without another upload or POST', { timeout: 35_000 }, async () => {
  const f = await fixture(); let s = f.service;
  try {
    for (const shot of [f.first, f.second]) await s.command({ type: 'shot.update', id: shot.id, patch: { skipImage: true } });
    f.behavior.createStatus = 503;
    const job: Job = await s.command({ type: 'segment.generate', id: f.segment.id }); await idle(s);
    assert.equal(job.status, 'uncertain'); assert.equal(job.remoteId, undefined); assert.equal(f.calls.creates, 1); assert.equal(f.calls.uploads, 1);
    assert.equal(s.s.takes.length, 0); await assert.rejects(s.command({ type: 'job.retry', id: job.id }), /未知提交/);
    const snapshot = structuredClone(job.payload.snapshot);
    s = await f.reopen(); const restored = s.s.jobs.find(item => item.id === job.id)!;
    assert.equal(restored.status, 'uncertain'); assert.deepEqual(restored.payload.snapshot, snapshot);
    await s.command({ type: 'job.resume', id: job.id, remoteId: 'fixture-remote-task' }); await idle(s);
    assert.equal(restored.status, 'succeeded', restored.error || ''); assert.equal(f.calls.creates, 1); assert.equal(f.calls.uploads, 1);
    assert.equal(f.calls.polls, 1); assert.equal(f.calls.downloads, 1);
    const take = s.take(restored.resultId); assert.equal(take.kind, 'video'); assert.equal(take.alignments.length, 2);
    assert.deepEqual(take.sourceClips, (snapshot as Segment).clips); assert.deepEqual(await readFile(s.asset(take.assetId).path), f.videoBytes);
    // Inject the durable state left by a crash after Take save but before alignment.
    const takeId = take.id; take.alignments = []; restored.status = 'failed'; restored.error = 'fixture: interrupted after download'; s.store.save();
    s = await f.reopen(); await s.command({ type: 'job.resume', id: job.id }); await idle(s);
    const resumed = s.s.jobs.find(item => item.id === job.id)!;
    assert.equal(resumed.status, 'succeeded', resumed.error || ''); assert.equal(resumed.resultId, takeId);
    assert.equal(s.s.takes.length, 1); assert.equal(s.take(takeId).alignments.length, 2);
    assert.equal(f.calls.creates, 1); assert.equal(f.calls.uploads, 1); assert.equal(f.calls.polls, 1); assert.equal(f.calls.downloads, 1);
  } finally { await f.close(); }
});
