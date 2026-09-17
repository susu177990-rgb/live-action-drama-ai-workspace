import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import { assemble, createProxy, extractFrame, probe, sceneDetect, suggestAlignment, waveform } from '../src/server/media.js';

const execute = promisify(execFile);
const options = { ffmpegPath: process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg', ffprobePath: process.env.FFPROBE_PATH || '/opt/homebrew/bin/ffprobe' };
let directory: string;
let cutsSource: string;
let silentSource: string;

async function ffmpeg(args: string[]) {
  return execute(options.ffmpegPath, ['-hide_banner', '-nostdin', '-v', 'error', ...args], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'yuguang-media-'));
  cutsSource = join(directory, 'red blue with sound.mp4');
  silentSource = join(directory, 'silent portrait.mp4');
  await Promise.all([
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=25:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=25:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', cutsSource]),
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=green:s=180x320:r=30:d=1.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silentSource]),
  ]);
});

after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

test('probes actual dimensions, duration, frame rate and absent audio', async () => {
  const actual = await probe(cutsSource, options);
  assert.equal(actual.kind, 'video');
  assert.equal(actual.width, 320);
  assert.equal(actual.height, 180);
  assert.equal(actual.fps, 25);
  assert.equal(actual.hasAudio, true);
  assert.ok(Math.abs(actual.duration - 2) < 0.03);
  const silent = await probe(silentSource, options);
  assert.equal(silent.hasAudio, false);
  assert.equal(silent.fps, 30);
  assert.equal(silent.height, 320);
});

test('detects the real cut and extracts the requested source frame', async () => {
  const cuts = await sceneDetect(cutsSource, { ...options, threshold: 0.2, minDuration: 0.2 });
  assert.deepEqual(cuts, [1]);
  for (const [time, channel] of [[0.3, 0], [1.3, 2]] as const) {
    const frame = join(directory, `frame-${time}.png`);
    await extractFrame(cutsSource, time, frame, options);
    assert.equal((await probe(frame, options)).kind, 'image');
    const { stdout } = await ffmpeg(['-i', frame, '-vf', 'scale=1:1', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
    assert.ok(stdout[channel] > 220, `expected dominant channel ${channel}: ${[...stdout]}`);
    assert.ok(stdout[channel === 0 ? 2 : 0] < 30);
  }
});

test('creates a playable proxy and measures real audio amplitude', async () => {
  const proxy = join(directory, 'proxy.mp4');
  await createProxy(cutsSource, proxy, options);
  const info = await probe(proxy, options);
  assert.equal(info.hasAudio, true);
  assert.ok(Math.abs(info.duration - 2) < 0.05);
  const bins = await waveform(proxy, options);
  assert.equal(bins.length, 240);
  assert.ok(bins.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
  assert.ok(Math.max(...bins) > 0.06);
  assert.deepEqual(await waveform(silentSource, options), []);
});

test('assembles trimmed mixed aspect/frame-rate sources with silence for missing audio', async () => {
  const output = join(directory, 'mixed.mp4');
  await assemble([{ path: cutsSource, in: 0.6, out: 1.4 }, { path: silentSource, in: 0.2, out: 0.9 }], output, { ...options, width: 320, height: 180, fps: 25 });
  const info = await probe(output, options);
  assert.equal(info.width, 320);
  assert.equal(info.height, 180);
  assert.equal(info.fps, 25);
  assert.equal(info.hasAudio, true);
  assert.ok(Math.abs(info.duration - 1.5) <= 0.05, `duration ${info.duration}`);
  const cuts = await sceneDetect(output, { ...options, threshold: 0.15, minDuration: 0.1 });
  assert.ok(cuts.some(time => Math.abs(time - 0.4) <= 0.04), `first trim cut ${cuts}`);
  assert.ok(cuts.some(time => Math.abs(time - 0.8) <= 0.04), `clip boundary ${cuts}`);
  const bins = await waveform(output, options);
  assert.ok(Math.max(...bins.slice(10, 100)) > 0.05);
  assert.ok(Math.max(...bins.slice(165, 225)) < 0.003, 'missing audio must become silence');
});

test('supports external original audio and explicitly audio-free exports', async () => {
  const external = join(directory, 'external audio.mp4');
  await assemble([{ path: silentSource, in: 0.2, out: 0.8, audioPath: cutsSource, audioIn: 0.4 }], external, options);
  assert.ok(Math.max(...await waveform(external, options)) > 0.05);
  const noAudio = join(directory, 'no-audio.mp4');
  await assemble([{ path: cutsSource, in: 0, out: 0.4 }], noAudio, { ...options, audio: 'none' });
  assert.equal((await probe(noAudio, options)).hasAudio, false);
});

test('alignment suggestions use cut evidence, cumulative anchors and require confirmation', async () => {
  const result = await suggestAlignment([{ shotId: 'shot-a', duration: 1 }, { shotId: 'shot-b', duration: 1 }], cutsSource, options);
  assert.equal(result[0].generatedOut, 1);
  assert.equal(result[1].generatedIn, 1);
  assert.equal(result[1].sourceIn, 1);
  assert.deepEqual(result[1].anchors, [{ source: 1, generated: 1 }, { source: 2, generated: 2 }]);
  assert.ok(result.every(item => !item.confirmed && item.confidence > 0.5 && item.confidence < 0.8));
  const uncertain = await suggestAlignment([{ shotId: 'a', duration: 1 }, { shotId: 'b', duration: 1 }], silentSource, options);
  assert.ok(uncertain.every(item => item.confidence <= 0.25 && !item.confirmed));
});

test('validates numeric bounds, preserves output files, reports executable errors and cancellation', async () => {
  await assert.rejects(extractFrame(cutsSource, NaN, join(directory, 'invalid.jpg'), options), /帧时间/);
  await assert.rejects(assemble([{ path: cutsSource, in: 1, out: 0 }], join(directory, 'invalid.mp4'), options), /出点/);
  await assert.rejects(assemble([{ path: cutsSource, in: 0, out: 3 }], join(directory, 'invalid.mp4'), options), /时长/);
  const existing = join(directory, 'existing.jpg');
  await writeFile(existing, 'keep this candidate');
  await assert.rejects(extractFrame(cutsSource, 0.1, existing, options), /EEXIST/);
  assert.equal(await readFile(existing, 'utf8'), 'keep this candidate');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(probe(cutsSource, { ...options, signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(probe(cutsSource, { ...options, ffprobePath: join(directory, 'missing executable') }), /无法运行媒体工具/);
  assert.ok((await readdir(directory)).every(name => !name.startsWith('.media-')), 'temporary output files cleaned');
});

test('cancellation interrupts an already running child process', async () => {
  const slowExecutable = join(directory, 'slow-probe');
  await writeFile(slowExecutable, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n');
  await chmod(slowExecutable, 0o755);
  const controller = new AbortController();
  const started = Date.now();
  const pending = probe(cutsSource, { ...options, ffprobePath: slowExecutable, signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 80);
  try { await assert.rejects(pending, { name: 'AbortError' }); }
  finally { clearTimeout(timer); }
  assert.ok(Date.now() - started < 3000, 'cancelled process must be reaped promptly');
});
