import express from "express";
import multer from "multer";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, rm, stat, readFile, open } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { Store } from "./store.js";
import { Service } from "./service.js";
import { extractFrame } from "./media.js";
import type { Server } from "node:http";
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export async function startServer(
  options: { dataDir?: string; port?: number; staticDir?: string; chooseFolder?: (kind: "storage" | "export") => Promise<string | null> } = {},
) {
  const dataDir =
    options.dataDir ||
    process.env.WORKBENCH_DATA_DIR ||
    path.join(projectRoot, ".workbench");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lock = path.join(dataDir, "server.lock");
  if (existsSync(lock)) {
    let active = false;
    try {
      const p = JSON.parse(readFileSync(lock, "utf8"));
      process.kill(p.pid, 0);
      active = true;
    } catch {}
    if (active)
      throw new Error("该数据目录已有工作台进程，请勿同时打开两个实例");
    unlinkSync(lock);
  }
  writeFileSync(lock, JSON.stringify({ pid: process.pid }), {
    flag: "wx",
    mode: 0o600,
  });
  let store: Store;
  try {
    store = await Store.open(dataDir);
  } catch (e) {
    unlinkSync(lock);
    throw e;
  }
  const service = new Service(store, options.chooseFolder);
  const framesInFlight = new Map<string, Promise<void>>();
  const app = express();
  app.disable("x-powered-by");
  const auth = randomBytes(32).toString("hex");
  app.use((req, res, next) => {
    const host = req.hostname;
    if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host))
      return res.status(403).json({ error: "仅允许本机访问" });
    const origin = req.get("origin");
    if (origin) {
      let u;
      try {
        u = new URL(origin);
      } catch {
        return res.status(403).json({ error: "无效来源" });
      }
      if (
        !["localhost", "127.0.0.1"].includes(u.hostname) ||
        (!["4318", "5173", ""].includes(u.port) &&
          u.port !== String(options.port))
      )
        return res.status(403).json({ error: "拒绝跨站请求" });
    }
    if (req.get("sec-fetch-site") === "cross-site")
      return res.status(403).json({ error: "拒绝跨站请求" });
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  const setSession = (res: express.Response) =>
    res.cookie("workbench_session", auth, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
    });
  app.get("/api/session", (_req, res) => {
    setSession(res);
    res.json({ ok: true });
  });
  app.get("/api/health", (_req, res) =>
    res.json({ application: "yuguang-workbench", version: "2.0.0" }),
  );
  app.use(["/api", "/media"], (req, res, next) => {
    const cookie =
      (req.headers.cookie || "")
        .split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith("workbench_session="))
        ?.slice("workbench_session=".length) || "";
    if (
      cookie.length !== auth.length ||
      !timingSafeEqual(Buffer.from(cookie), Buffer.from(auth))
    )
      return res.status(401).json({ error: "请刷新工作台重新建立本地会话" });
    next();
  });
  app.use(express.json({ limit: "8mb" }));
  app.get("/api/state", (_req, res) => res.json({...store.publicState(), codexConnection: {...service.connection.state}}));
  app.post("/api/command", async (req, res, next) => {
    try {
      const result = await service.command(req.body);
      res.json({ state: store.publicState(), result });
    } catch (e) {
      next(e);
    }
  });
  const uploads = path.join(dataDir, "uploads");
  await mkdir(uploads, { recursive: true });
  const upload = multer({
    dest: uploads,
    limits: { fileSize: 20 * 1024 ** 3, files: 100, fieldSize: 1024 * 1024 },
  });
  app.post("/api/script-text", upload.single("file"), async (req, res, next) => {
    try {
      if (!req.file) throw new Error("请选择总剧本文件");
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (![".txt", ".md", ".docx", ".pdf", ".json"].includes(ext)) throw new Error("支持 TXT、Markdown、DOCX、PDF 剧本");
      const script = await service.documentText(req.file.path, ext);
      if (!script.trim() || script.length > 300000) throw new Error("剧本为空或超过30万字符，请拆分文件");
      res.json({ script });
    } catch (e) { next(e); } finally { if (req.file) await rm(req.file.path, { force: true }); }
  });
  app.post(
    "/api/import",
    upload.array("files", 100),
    async (req, res, next) => {
      const files = (req.files as Express.Multer.File[]) || [];
      const results: unknown[] = [];
      const errors: string[] = [];
      try {
        if (!req.body.episodeId) throw new Error("缺少集 ID");
        for (const file of files) {
          try {
            const filename = Buffer.from(file.originalname, "latin1").toString(
              "utf8",
            );
            results.push(
              await service.import(
                file.path,
                req.body.episodeId,
                req.body.role || "source",
                filename,
                req.body.shotId,
                req.body.segmentId,
              ),
            );
          } catch (e) {
            errors.push(`${file.originalname}: ${(e as Error).message}`);
          } finally {
            await rm(file.path, { force: true });
          }
        }
        if (!files.length) throw new Error("未选择文件");
        res.json({ state: store.publicState(), result: results, errors });
      } catch (e) {
        next(e);
      } finally {
        for (const file of files) await rm(file.path, { force: true });
      }
    },
  );
  app.get("/api/frame", async (req, res, next) => {
    try {
      const a = service.asset(req.query.assetId);
      if (a.kind !== "video") throw new Error("只能从视频抽帧");
      const t = Number(req.query.time);
      if (!Number.isFinite(t) || t < 0 || t >= (a.duration || Infinity))
        throw new Error("截帧时间无效");
      const folder = path.join(dataDir, "frame-cache");
      await mkdir(folder, { recursive: true });
      const frame = path.join(folder, `${a.id}-${Math.round(t * 1000000)}.jpg`);
      if (!existsSync(frame)) {
        let pending = framesInFlight.get(frame);
        if (!pending) {
          pending = extractFrame(a.path, t, frame, service.opts).finally(() =>
            framesInFlight.delete(frame),
          );
          framesInFlight.set(frame, pending);
        }
        await pending;
      }
      res.type("image/jpeg").sendFile(frame, { dotfiles: "allow" });
    } catch (e) {
      next(e);
    }
  });
  app.get("/media/:id", async (req, res, next) => {
    try {
      const a = service.asset(req.params.id);
      if (
        req.query.thumbnail === "1" &&
        a.kind === "video" &&
        !a.thumbnailPath
      ) {
        const folder = path.join(dataDir, "thumbnails");
        await mkdir(folder, { recursive: true });
        const target = path.join(folder, `${a.id}.jpg`);
        if (!existsSync(target)) {
          let pending = framesInFlight.get(target);
          if (!pending) {
            pending = extractFrame(
              a.path,
              Math.min(0.5, (a.duration || 1) / 2),
              target,
              service.opts,
            ).finally(() => framesInFlight.delete(target));
            framesInFlight.set(target, pending);
          }
          await pending;
        }
        a.thumbnailPath = target;
        store.save();
      }
      const file =
        req.query.thumbnail === "1"
          ? a.thumbnailPath || (a.kind === "image" ? a.path : undefined)
          : req.query.original === "1"
            ? a.path
            : a.proxyPath || a.path;
      if (!file) throw new Error("缩略图尚未生成");
      await stat(file);
      if (req.query.download === "1")
        return res.download(file, a.name, { dotfiles: "allow" });
      res.sendFile(path.resolve(file), {
        acceptRanges: true,
        dotfiles: "allow",
        cacheControl: false,
      });
    } catch (e) {
      next(e);
    }
  });
  const staticDir = options.staticDir || path.join(projectRoot, "dist");
  app.use((req, res, next) => {
    if (req.path === "/" || req.path === "/index.html") setSession(res);
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
    );
    next();
  });
  app.use(express.static(staticDir));
  app.get("/", (_req, res) =>
    res
      .status(503)
      .type("text")
      .send(
        "前端尚未构建，请运行 npm run build，然后刷新。开发界面可运行 npx vite。",
      ),
  );
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error("[workbench]", err.message);
      res.status(400).json({ error: err.message || "操作失败" });
    },
  );
  let server: Server;
  try {
    server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(
        options.port ?? Number(process.env.PORT || 4318),
        "127.0.0.1",
        () => resolve(s),
      );
      s.on("error", reject);
    });
  } catch (e) {
    store.close();
    unlinkSync(lock);
    throw e;
  }
  void service.drain();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await service.shutdown();
    server.close();
    store.close();
    if (existsSync(lock)) unlinkSync(lock);
  };
  return {
    app,
    server,
    store,
    service,
    close,
    url: `http://127.0.0.1:${(server.address() as any).port}`,
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  startServer()
    .then((runtime) => {
      console.log(`实拍工作台已启动：${runtime.url}`);
      for (const event of ["SIGINT", "SIGTERM"] as const)
        process.on(event, () => {
          void runtime.close().then(() => process.exit(0));
        });
    })
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
}
