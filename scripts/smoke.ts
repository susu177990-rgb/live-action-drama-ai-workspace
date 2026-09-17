import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { Store } from "../src/server/store.js";
import { Service } from "../src/server/service.js";
import * as media from "../src/server/media.js";
const source = process.argv[2];
if (!source) throw new Error("用法：npm run smoke -- /绝对路径/原视频.mp4");
const folder = path.resolve(".workbench/verification-" + Date.now());
await mkdir(folder, { recursive: true });
const store = await Store.open(folder);
const service = new Service(store);
async function idle() {
  for (let i = 0; i < 1200; i++) {
    if (!store.state.jobs.some((j) => ["queued", "running"].includes(j.status)))
      return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("联调超时");
}
try {
  const info = await media.probe(source, service.opts);
  const sample = path.join(folder, "real-source-excerpt.mp4");
  await media.assemble(
    [{ path: source, in: 0, out: Math.min(6, info.duration) }],
    sample,
    { ...service.opts, width: 640, height: 360 },
  );
  const ep = await service.command({
    type: "episode.create",
    name: "验收 · 真实实拍素材（隔离测试）",
  });
  const asset = await service.import(
    sample,
    ep.id,
    "source",
    "实拍片头6秒.mp4",
  );
  await idle();
  const shot = store.state.shots[0];
  await service.command({
    type: "shot.update",
    id: shot.id,
    patch: {
      facts: "媒体联调样片，镜头语义待正式分析",
      plan: "仅验证媒体链路",
      confirmed: true,
      skipImage: true,
    },
  });
  const seg = await service.command({
    type: "segment.create",
    episodeId: ep.id,
    shotIds: [shot.id],
  });
  await service.command({ type: "segment.prepare", id: seg.id });
  await idle();
  await service.import(
    sample,
    ep.id,
    "video-take",
    "对齐验证副本（非AI生成）.mp4",
    undefined,
    seg.id,
  );
  await idle();
  const take = store.state.takes[0];
  await service.command({ type: "take.approve", id: take.id });
  await service.command({
    type: "export.video",
    episodeId: ep.id,
    audio: "original",
  });
  await idle();
  const failed = store.state.jobs.filter((j) => j.status !== "succeeded");
  if (failed.length) throw new Error(JSON.stringify(failed));
  const report = {
    source,
    sourceInfo: info,
    dataDir: folder,
    epId: ep.id,
    assetId: asset.id,
    segmentId: seg.id,
    takeId: take.id,
    jobs: store.state.jobs.map(({ type, status, resultId }) => ({
      type,
      status,
      resultId,
    })),
    evidence:
      "使用真实原片截取6秒；人工导入同片作为对齐测试副本，并非AI生成；原始文件只读。",
  };
  await mkdir("docs/verification", { recursive: true });
  await writeFile(
    "docs/verification/media-smoke.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  service.shutdown();
  store.close();
}
