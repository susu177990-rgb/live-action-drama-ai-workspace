import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Store } from "../src/server/store.js";
import { Service } from "../src/server/service.js";
import { probe } from "../src/server/media.js";
import { startServer } from "../src/server/index.js";
const exec = promisify(execFile);
async function idle(s: Service) {
  for (let i = 0; i < 500; i++) {
    if (!s.s.jobs.some((j) => ["queued", "running"].includes(j.status))) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("任务超时");
}
test("real local workflow: import → cuts → assemble → manual take → align → approve → export → restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "workbench-service-"));
  const store = await Store.open(dir);
  const s = new Service(store);
  try {
    const ep = await s.command({ type: "episode.create", name: "验证集" });
    const file = path.join(dir, "source.mp4");
    await exec("/opt/homebrew/bin/ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=red:s=160x90:r=25:d=2",
      "-f",
      "lavfi",
      "-i",
      "color=blue:s=160x90:r=25:d=2",
      "-filter_complex",
      "[0:v][1:v]concat=n=2:v=1:a=0[v]",
      "-map",
      "[v]",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      file,
    ]);
    const asset = await s.import(file, ep.id, "source", "实拍素材.mp4");
    await idle(s);
    assert.equal(s.s.jobs[0].status, "succeeded");
    assert.ok(s.s.assets[0].proxyPath);
    await s.command({
      type: "shots.detect",
      assetId: asset.id,
      threshold: 0.15,
      minDuration: 0.3,
    });
    await idle(s);
    assert.equal(s.s.shots.length, 2);
    for (const sh of s.s.shots)
      await s.command({
        type: "shot.update",
        id: sh.id,
        patch: {
          facts: "已人工核验红蓝场景，平视机位，无人物",
          plan: "保持机位",
          confirmed: true,
          skipImage: true,
        },
      });
    const segment = await s.command({
      type: "segment.create",
      episodeId: ep.id,
      shotIds: s.s.shots.map((x) => x.id),
    });
    assert.equal(segment.duration, 4);
    await assert.rejects(
      () => s.command({ type: "segment.generate", id: segment.id }),
      /API Key/,
    );
    await s.command({ type: "segment.prepare", id: segment.id });
    await idle(s);
    assert.ok(segment.sourceAssetId);
    await s.import(
      file,
      ep.id,
      "video-take",
      "人工生成版本.mp4",
      undefined,
      segment.id,
    );
    await idle(s);
    const take = s.s.takes[0];
    assert.equal(take.alignments.length, 2);
    assert.equal(take.alignments[0].confirmed, false);
    await s.command({ type: "take.approve", id: take.id });
    await s.command({
      type: "review.create",
      takeId: take.id,
      time: 1,
      text: "保留红色镜头",
    });
    const bad = structuredClone(take.alignments);
    bad[0].anchors = [
      { source: 1, generated: 1 },
      { source: 0.5, generated: 1.5 },
    ];
    await assert.rejects(
      () => s.command({ type: "take.align", id: take.id, alignments: bad }),
      /严格递增/,
    );
    await s.command({ type: "take.trim", id: take.id, in: 0.25 });
    await s.command({ type: "take.trim", id: take.id, out: 3.75 });
    assert.equal(take.exportIn, 0.25);
    assert.equal(take.exportOut, 3.75);
    await assert.rejects(() => s.command({ type: "take.trim", id: take.id, out: 0.1 }), /成片出点/);
    assert.equal(take.exportIn, 0.25);
    await s.command({ type: "take.trim", id: take.id, in: 1, out: 3 });
    const exp = await s.command({
      type: "export.video",
      episodeId: ep.id,
      audio: "original",
    });
    await idle(s);
    assert.equal(exp.status, "succeeded", exp.error);
    assert.ok(exp.resultId);
    assert.ok(
      Math.abs((await probe(s.asset(exp.resultId).path, s.opts)).duration - 2) <
        0.1,
    );
    assert.ok((await readFile(s.asset(exp.resultId).path)).length > 1000);
    await s.command({
      type: "settings.update",
      patch: { apiKey: "local-test-secret" },
    });
    assert.equal(s.store.publicState().settings.apiKey, "");
    assert.ok(
      !(await readFile(path.join(dir, "workbench.sqlite"))).includes(
        Buffer.from("local-test-secret"),
      ),
    );
    const epId = ep.id;
    store.close();
    const reopened = await Store.open(dir);
    assert.equal(reopened.state.episodes[0].id, epId);
    assert.equal(reopened.state.reviews.length, 1);
    assert.equal(reopened.state.settings.apiKey, "local-test-secret");
    reopened.close();
  } finally {
    s.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
test("HTTP boundary denies cross-site and unauthenticated state; session + media range work", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "workbench-http-"));
  const runtime = await startServer({
    dataDir: path.join(dir, ".hidden-workbench"),
    port: 0,
  });
  try {
    assert.equal((await fetch(runtime.url + "/api/state")).status, 401);
    assert.equal(
      (
        await fetch(runtime.url + "/api/session", {
          headers: { Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    const session = await fetch(runtime.url + "/api/session");
    const cookie = session.headers.get("set-cookie")!.split(";")[0];
    const epRes = await fetch(runtime.url + "/api/command", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "episode.create", name: "HTTP集" }),
    });
    assert.equal(epRes.status, 200);
    const ep = (await epRes.json()).result;
    const form = new FormData();
    form.set("episodeId", ep.id);
    form.set("role", "script");
    form.append(
      "files",
      new Blob(["原始剧本中文"], { type: "text/plain" }),
      "script.txt",
    );
    const imported = await fetch(runtime.url + "/api/import", {
      method: "POST",
      headers: { Cookie: cookie },
      body: form,
    });
    const body = await imported.json();
    assert.equal(body.errors.length, 0);
    assert.ok(body.state.episodes[0].script.includes("原始剧本中文"));
    const media = await fetch(runtime.url + "/media/" + body.result[0].id, {
      headers: { Cookie: cookie, Range: "bytes=0-2" },
    });
    assert.equal(media.status, 206);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("crash recovery marks unknown video submissions uncertain and never auto retries", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "workbench-recovery-"));
  let store = await Store.open(dir);
  try {
    store.state.jobs.push({
      id: "unknown",
      episodeId: "e",
      targetId: "s",
      type: "segment.generate",
      status: "running",
      progress: 0.1,
      message: "",
      createdAt: "",
      updatedAt: "",
      payload: { submissionStarted: true },
    });
    store.save();
    store.close();
    store = await Store.open(dir);
    assert.equal(store.state.jobs[0].status, "uncertain");
    const service = new Service(store);
    await assert.rejects(
      () => service.command({ type: "job.retry", id: "unknown" }),
      /未知提交/,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
