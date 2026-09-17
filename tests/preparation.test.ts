import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Store } from "../src/server/store.js";
import { Service } from "../src/server/service.js";
import { groupedClips } from "../src/server/preparation.js";
import { extractFrame } from "../src/server/media.js";
import type { Shot } from "../src/shared/types.js";
const exec = promisify(execFile);
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
async function idle(service: Service) {
  for (let i = 0; i < 1500; i++) {
    if (!service.s.jobs.some(j => ["queued", "running"].includes(j.status))) return;
    await pause();
  }
  throw new Error("Fixture job timeout");
}
async function fixture() {
  const base = path.resolve(".workbench");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, "verification-preparation-"));
  const store = await Store.open(dir);
  const service = new Service(store);
  const ep = await service.command({ type: "episode.create", name: "假 CLI 流程验收" });
  const source = path.join(dir, "source.mp4");
  await exec(service.opts.ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", "color=red:s=160x90:r=25:d=2", "-f", "lavfi", "-i", "color=blue:s=160x90:r=25:d=2", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", source]);
  const asset = await service.import(source, ep.id, "source");
  await idle(service);
  const reference = path.join(dir, "reference.jpg");
  await extractFrame(source, 0, reference, service.opts);
  const ref = await service.import(reference, ep.id, "scene");
  const cli = path.join(dir, "fake-codex.mjs");
  const log = path.join(dir, "calls.jsonl");
  const control = path.join(dir, "control.json");
  await writeFile(control, "{}");
  await writeFile(cli, `#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2);let prompt='';for await(const c of process.stdin)prompt+=c;
const schema=args.includes('--output-schema')?JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8')):null;
const phase=schema?.properties?.assets?'materials':schema?.properties?.scene?'shots':'prompt';
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({phase,prompt,images:args.filter((a,i)=>args[i-1]==='-i')})+'\\n');
const control=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));
if(control.delayPhase===phase)await new Promise(r=>setTimeout(r,400));
const records=fs.readFileSync(${JSON.stringify(log)},'utf8').trim().split('\\n').map(x=>JSON.parse(x));
if(control.failPhase===phase && records.filter(x=>x.phase===phase).length===control.failAt){console.error('fixture intentional failure');process.exit(3)}
let data;
if(phase==='materials')data={assets:JSON.parse(prompt.match(/素材：(\\[[^\\n]*\\])/)[1]).map(a=>({id:a.id,analysis:'假CLI证据：上传的'+a.role+'素材'}))};
else if(phase==='shots')data={scene:'室内',facts:'假CLI：原片首帧平视固定机位，无人物',plan:'构图保持；背景参考；透视保持；光影遵循素材；最终画面按要求；VFX无',referenceIds:[control.unknownRef||${JSON.stringify(ref.id)}],imagePrompt:'假CLI：保持原片首帧机位，只应用参考场景',videoPrompt:'假CLI：保留原片动作与剪辑，不发明对白',issues:control.issues||[]};
else data='假CLI全集提示词：逐镜保留原片，使用本集资产。';
const output=typeof data==='string'?data:JSON.stringify(data);fs.writeFileSync(args[args.indexOf('-o')+1],output);console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:output}}));
`);
  await chmod(cli, 0o755);
  store.state.settings.codexPath = cli;
  store.save();
  const calls = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const cleanup = async () => { await service.shutdown(); store.close(); await rm(dir, { recursive: true, force: true }); };
  return { dir, store, service, ep, asset, ref, source, control, calls, cleanup };
}

test("automatic preparation understands uploads first, saves exact first frames, plans without blanket confirmation and groups idempotently", async () => {
  const f = await fixture();
  try {
    const document = path.join(f.dir, "reference.txt"); await writeFile(document, "道具说明，不是剧本");
    await f.service.import(document, f.ep.id, "reference");
    const referenceVideo = await f.service.import(f.source, f.ep.id, "reference_video");
    assert.equal(f.ep.script, "");
    assert(!f.service.s.shots.some(s => s.assetId === referenceVideo.id));
    await f.service.command({ type: "episode.update", id: f.ep.id, patch: { brief: "场景替换" } });
    const job = await f.service.command({ type: "episode.prepare", episodeId: f.ep.id });
    assert.equal((await f.service.command({ type: "episode.prepare", episodeId: f.ep.id })).id, job.id);
    await idle(f.service);
    assert.equal(job.status, "succeeded", job.error);
    assert.equal(f.ep.preparation.status, "ready");
    const shots = f.service.s.shots.filter(s => s.assetId === f.asset.id);
    assert.equal(shots.length, 2);
    assert.match(f.ep.materialAnalysis, /上传/);
    assert.match(f.service.asset(f.ref.id).analysis!, /scene/);
    for (const shot of shots) {
      assert(shot.automated && shot.confirmed);
      assert.deepEqual(shot.issues, []);
      assert.equal(shot.sourceFrameTime, shot.in);
      assert(shot.imagePrompt && shot.videoPrompt && shot.referenceIds.includes(f.ref.id));
      const exact = path.join(f.dir, `expected-${shot.id}.jpg`);
      await extractFrame(f.source, shot.in, exact, f.service.opts);
      assert.deepEqual(await readFile(f.service.asset(shot.sourceFrameId).path), await readFile(exact));
    }
    const revisionBeforeNoopSave = shots[0].revision;
    await f.service.command({ type: "episode.update", id: f.ep.id, patch: { brief: f.ep.brief } });
    assert.equal(shots[0].revision, revisionBeforeNoopSave, "saving an unchanged episode must not invalidate completed shots");
    const calls = await f.calls();
    assert.equal(calls[0].phase, "materials");
    assert(calls[0].images.length >= 4);
    assert.equal(calls.filter(c => c.phase === "shots").length, 2);
    assert(calls.find(c => c.phase === "shots").images.includes(f.service.asset(shots[0].sourceFrameId).path));
    const groups = await f.service.command({ type: "episode.group", episodeId: f.ep.id });
    assert.equal(groups.length, 1); assert.equal(groups[0].duration, 4); assert.match(groups[0].prompt, /片段内/);
    assert.deepEqual((await f.service.command({ type: "episode.group", episodeId: f.ep.id })).map((s: any) => s.id), groups.map((s: any) => s.id));
    const again = await f.service.command({ type: "episode.prepare", episodeId: f.ep.id });
    await idle(f.service);
    assert.equal(again.status, "succeeded", again.error);
    assert.equal((await f.calls()).length, calls.length, "completed units are not billed again");
    await f.service.command({ type: "shot.update", id: shots[0].id, patch: { facts: "用户已直接修正原片事实" } });
    assert.equal(shots[0].confirmed, true);
  } finally { await f.cleanup(); }
});

test("skip analysis still detects cuts and captures first frames without calling Codex", async () => {
  const f = await fixture();
  try {
    const queued = await f.service.command({ type: "episode.prepare", episodeId: f.ep.id });
    await f.service.command({ type: "preparation.pause", id: queued.id });
    await new Promise(resolve => setTimeout(resolve, 500));
    const job = await f.service.command({ type: "episode.prepareWithoutAnalysis", episodeId: f.ep.id });
    await idle(f.service);
    assert.equal(job.status, "succeeded", job.error);
    assert.equal(f.ep.preparation?.status, "ready");
    assert.equal(f.ep.analysisSkipped, true);
    const shots = f.service.s.shots.filter(s => s.episodeId === f.ep.id);
    assert.equal(shots.length, 2);
    assert.equal((await f.calls()).length, 0, "skip mode must not call Codex");
    for (const shot of shots) {
      assert.equal(shot.analysisSkipped, true);
      assert.equal(shot.confirmed, true);
      assert(shot.sourceFrameId);
      assert(shot.imagePrompt.trim());
    }
  } finally { await f.cleanup(); }
});

test("failed preparation persists checkpoints and retry resumes only unfinished shots", async () => {
  const f = await fixture();
  try {
    await writeFile(f.control, JSON.stringify({ failPhase: "shots", failAt: 2 }));
    const job = await f.service.command({ type: "episode.prepare", episodeId: f.ep.id });
    await idle(f.service);
    assert.equal(job.status, "failed"); assert.equal(f.ep.preparation.status, "failed");
    const first = f.service.s.shots[0];
    assert(first.confirmed && first.videoPrompt);
    first.revision++;
    f.store.save();
    const before = structuredClone(first);
    assert.equal(Object.keys(job.payload.preparation.shots).length, 1);
    // SQLite recovery, not merely an in-memory retry.
    const reopened = await Store.open(f.dir);
    const resumed = new Service(reopened);
    await writeFile(f.control, "{}");
    try {
      await resumed.command({ type: "job.retry", id: job.id });
      await idle(resumed);
      assert.equal(resumed.s.jobs.find(j => j.id === job.id)!.status, "succeeded");
      assert.deepEqual(resumed.shot(first.id), before);
      const calls = await f.calls();
      assert.equal(calls.filter(c => c.phase === "materials").length, 1);
      assert.equal(calls.filter(c => c.phase === "shots").length, 3, "a revision-only change must still reuse the completed shot checkpoint");
    } finally { await resumed.shutdown(); reopened.close(); }
  } finally { await f.cleanup(); }
});

test("mid-run edits survive and project input changes stop stale material results", async () => {
  const f = await fixture();
  try {
    await writeFile(f.control, JSON.stringify({ delayPhase: "materials" }));
    const job = await f.service.command({ type: "episode.prepare", episodeId: f.ep.id });
    while (!(await f.calls()).length) await pause();
    await f.service.command({ type: "episode.update", id: f.ep.id, patch: { brief: "运行中改成新的要求" } });
    await idle(f.service);
    assert.equal(job.status, "failed"); assert.match(job.error, /已修改/); assert.equal(f.ep.materialAnalysis, undefined);
    await writeFile(f.control, JSON.stringify({ delayPhase: "shots" }));
    const retried = await f.service.command({ type: "episode.prepare", episodeId: f.ep.id });
    while (!(await f.calls()).some(c => c.phase === "shots")) await pause();
    const shot = f.service.s.shots[0];
    await f.service.command({ type: "shot.update", id: shot.id, patch: { facts: "用户在分析中指定：保持这条事实" } });
    await idle(f.service);
    assert.equal(retried.status, "failed"); assert.match(retried.error, /未覆盖/); assert.match(shot.facts, /用户在分析中/);
    await writeFile(f.control, "{}");
    await f.service.command({ type: "job.retry", id: retried.id });
    await idle(f.service);
    assert.equal(retried.status, "succeeded", retried.error); assert.match(shot.facts, /用户在分析中/);
  } finally { await f.cleanup(); }
});

test("high-impact issues stay explicit and unknown reference IDs are rejected", async () => {
  const f = await fixture();
  try {
    await writeFile(f.control, JSON.stringify({ unknownRef: "foreign-project-id" }));
    const job = await f.service.command({ type: "episode.prepare", episodeId: f.ep.id });
    await idle(f.service);
    assert.equal(job.status, "failed"); assert.match(job.error, /其他项目素材/);
    assert(!f.service.s.shots[0].facts);
    await writeFile(f.control, JSON.stringify({ issues: ["人物身份与服装图是否对应"] }));
    await f.service.command({ type: "job.retry", id: job.id });
    await idle(f.service);
    assert.equal(job.status, "succeeded", job.error);
    assert.equal(f.ep.preparation.status, "ready");
    assert.equal(f.service.s.shots[0].confirmed, false);
    assert.equal(f.service.s.shots[0].issues?.length, 1);
    await f.service.command({ type: "shot.update", id: f.service.s.shots[0].id, patch: { issues: [], facts: "已修正人物身份对应" } });
    assert.equal(f.service.s.shots[0].confirmed, true);
    const rerun = await f.service.command({ type: "episode.prepare", episodeId: f.ep.id });
    await idle(f.service);
    assert.equal(rerun.status, "succeeded", rerun.error);
    assert.deepEqual(f.service.s.shots[0].issues, [], "explicitly resolved issues must survive later AI analysis");
    assert.equal(f.service.s.shots[0].confirmed, true);
  } finally { await f.cleanup(); }
});

test("grouping balances tiny tails and splits long source ranges without gaps or duplicates", () => {
  const shot = (id: string, start: number, end: number) => ({ id, assetId: "a", in: start, out: end }) as Shot;
  for (const [shots, limit] of [[ [shot("a", 100, 161)], 30 ], [[shot("a", 0, 13)], 6], [[shot("a", 0, 28), shot("b", 28, 31)], 30]] as [Shot[], number][]) {
    const groups = groupedClips(shots, limit);
    for (const clips of groups) {
      const length = clips.reduce((n, c) => n + c.out - c.in, 0);
      assert(length >= 4 - 1e-7 && length <= limit + 1e-7);
    }
    for (const input of shots) {
      const clips = groups.flat().filter(c => c.shotId === input.id);
      assert.equal(clips[0].in, input.in); assert.equal(clips.at(-1)!.out, input.out);
      for (let i = 1; i < clips.length; i++) assert.equal(clips[i].in, clips[i - 1].out);
    }
  }
  assert.throws(() => groupedClips([shot("a", 0, 2)]), /不足 4 秒/);
});

test("image generation fallback binds the source first frame even when the fake image CLI fails", async () => {
  const f = await fixture();
  try {
    const shot = f.service.s.shots[0];
    await f.service.command({ type: "shot.update", id: shot.id, patch: { facts: "首帧是红色，镜头中部是蓝色", imagePrompt: "保持首帧", confirmed: true } });
    const job = await f.service.command({ type: "ai.image", shotId: shot.id });
    await idle(f.service);
    assert.equal(job.status, "failed", "fake CLI has no image-generation implementation and must never be reported as success");
    assert.equal(f.service.s.takes.length, 0);
    assert.equal(shot.sourceFrameTime, 0);
    assert(shot.sourceFrameId);
    const expected = path.join(f.dir, "expected-first.jpg");
    const midpoint = path.join(f.dir, "midpoint.jpg");
    await extractFrame(f.source, 0, expected, f.service.opts);
    await extractFrame(f.source, 2, midpoint, f.service.opts);
    const actual = await readFile(f.service.asset(shot.sourceFrameId).path);
    assert.deepEqual(actual, await readFile(expected));
    assert.notDeepEqual(actual, await readFile(midpoint));
    assert.equal((await f.calls())[0].images[0], f.service.asset(shot.sourceFrameId).path);
  } finally { await f.cleanup(); }
});


test("preparation uploads can remove untouched placeholders but retain edited and referenced sources", async () => {
  const f = await fixture();
  try {
    await f.service.command({ type: "asset.remove", id: f.asset.id });
    assert(!f.service.s.assets.some(a => a.id === f.asset.id));
    assert(!f.service.s.shots.some(s => s.assetId === f.asset.id));
    assert((await readFile(f.asset.path)).length > 0, "source file remains on disk");
    const edited = await f.service.import(f.source, f.ep.id, "source"); await idle(f.service);
    const shot = f.service.s.shots.find(s => s.assetId === edited.id)!;
    await f.service.command({ type: "shot.update", id: shot.id, patch: { name: "人工命名" } });
    await assert.rejects(() => f.service.command({ type: "asset.remove", id: edited.id }), /仍被镜头/);
    const linked = await f.service.import(f.source, f.ep.id, "source"); await idle(f.service);
    const linkedShot = f.service.s.shots.find(s => s.assetId === linked.id)!;
    await f.service.command({ type: "segment.create", episodeId: f.ep.id, shotIds: [linkedShot.id] });
    await assert.rejects(() => f.service.command({ type: "asset.remove", id: linked.id }), /仍被镜头/);
    const document = path.join(f.dir, "wrong-script.txt"); await writeFile(document, "错传剧本");
    const script = await f.service.import(document, f.ep.id, "script");
    assert.match(f.ep.script, /错传剧本/);
    await f.service.command({ type: "asset.remove", id: script.id });
    assert.equal(f.ep.script, "");
  } finally { await f.cleanup(); }
});


test("pause aborts analysis, preserves checkpoints across restart, and resume finishes remaining work", async () => {
  const f = await fixture();
  let resumed: Service | undefined;
  let reopened: Store | undefined;
  try {
    await writeFile(f.control, JSON.stringify({ delayPhase: "shots" }));
    const job = await f.service.command({ type: "episode.prepare", episodeId: f.ep.id });
    for (let i = 0; i < 500 && !(await f.calls()).some(c => c.phase === "shots"); i++) await pause();
    assert((await f.calls()).some(c => c.phase === "shots"));
    await f.service.command({ type: "preparation.pause", id: job.id });
    const progress = job.progress;
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(job.status, "paused");
    assert.equal(f.ep.preparation.status, "paused");
    assert.equal(job.progress, progress);
    assert.match(job.message, /已暂停/);
    assert.equal((await f.service.command({ type: "episode.prepare", episodeId: f.ep.id })).id, job.id);
    const count = (await f.calls()).length;
    await f.service.shutdown(); f.store.close();
    reopened = await Store.open(f.dir); resumed = new Service(reopened);
    await resumed.drain();
    assert.equal(reopened.state.jobs.find(j => j.id === job.id)?.status, "paused");
    assert.equal((await f.calls()).length, count, "restart must not resume without user action");
    await writeFile(f.control, "{}");
    await resumed.command({ type: "preparation.resume", id: job.id });
    await idle(resumed);
    const complete = resumed.s.jobs.find(j => j.id === job.id)!;
    assert.equal(complete.status, "succeeded", complete.error || "preparation should finish");
    assert.equal((await f.calls()).filter(c => c.phase === "materials").length, 1, "completed material analysis must be reused");
    assert.equal(resumed.s.episodes[0].preparation?.status, "ready");
  } finally {
    if (resumed) { await resumed.shutdown(); reopened!.close(); await rm(f.dir, { recursive: true, force: true }); }
    else await f.cleanup();
  }
});
