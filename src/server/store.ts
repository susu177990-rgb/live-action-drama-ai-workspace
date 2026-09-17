import initSqlJs, { type Database } from "sql.js";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  chmodSync,
} from "node:fs";
import path from "node:path";
import type { WorkspaceState, Settings } from "../shared/types.js";
const require = createRequire(import.meta.url);
export const now = () => new Date().toISOString();
export function defaultSettings(dataDir: string): Settings {
  return {
    storageDir:'', exportDir:'',
    llmProvider:'codex', imageProvider:'codex',
    llmApiBaseUrl:'', llmApiKey:'', llmApiModel:'',
    imageApiBaseUrl:'', imageApiKey:'', imageApiModel:'',
    codexPath:
      process.platform === "darwin"
        ? "/Applications/ChatGPT.app/Contents/Resources/codex"
        : "codex",
    codexModel: "",
    ffmpegPath:
      process.platform === "darwin" ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg",
    ffprobePath:
      process.platform === "darwin" ? "/opt/homebrew/bin/ffprobe" : "ffprobe",
    apiBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKey: "",
    videoModel: "",
    uploadBaseUrl: "",
    videoDurationLimit: 30,
    resolution: "720p",
    ratio: "adaptive",
    generateAudio: true,
    dataDir,
    imageCapability: "尚未验证",
  };
}
export function emptyState(dataDir: string): WorkspaceState {
  return {
    projects: [],
    episodes: [],
    assets: [],
    shots: [],
    segments: [],
    takes: [],
    reviews: [],
    jobs: [],
    settings: defaultSettings(dataDir),
    revision: 0,
  };
}
function atomicWrite(file: string, data: Uint8Array | string) {
  const temp = file + ".tmp";
  writeFileSync(temp, data, { mode: 0o600 });
  const fd = openSync(temp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
  chmodSync(file, 0o600);
}
export class Store {
  state: WorkspaceState;
  private db: Database;
  private file: string;
  private constructor(db: Database, dataDir: string) {
    this.db = db;
    this.file = path.join(dataDir, "workbench.sqlite");
    this.state = emptyState(dataDir);
  }
  static async open(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const SQL = await initSqlJs({
      locateFile: () => require.resolve("sql.js/dist/sql-wasm.wasm"),
    });
    const file = path.join(dataDir, "workbench.sqlite");
    const db = existsSync(file)
      ? new SQL.Database(readFileSync(file))
      : new SQL.Database();
    db.run(
      "CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS revisions (id INTEGER PRIMARY KEY, created TEXT NOT NULL, json TEXT NOT NULL)",
    );
    const store = new Store(db, dataDir);
    const rows = db.exec("SELECT json FROM workspace WHERE id=1");
    if (rows[0]?.values[0])
      store.state = JSON.parse(String(rows[0].values[0][0]));
    store.state.projects ??= [];
    store.state.settings = {
      ...defaultSettings(dataDir),
      ...store.state.settings,
      dataDir,
      apiKey: "", llmApiKey: "", imageApiKey: "",
    };
    const secrets = path.join(dataDir, "secrets.json");
    if (existsSync(secrets)) {
      const values=JSON.parse(readFileSync(secrets,"utf8"));
      for(const key of ['apiKey','llmApiKey','imageApiKey'] as const) store.state.settings[key]=values[key]||'';
    }
    for (const job of store.state.jobs) {
      if (job.status === "running") {
        job.status = job.remoteId
          ? "waiting"
          : job.type === "segment.generate"
            ? "uncertain"
            : "failed";
        job.message = job.remoteId
          ? "重启后等待查询远端任务"
          : job.status === "uncertain"
            ? "提交状态未知，请核对远端任务后填入 ID 恢复；不要重复提交"
            : "进程中断，可重试本地任务";
        job.error = job.message;
        job.updatedAt = now();
      }
    }
    store.save();
    return store;
  }
  publicState() {
    const state = structuredClone(this.state);
    const apiKeySet = !!state.settings.apiKey;
    const llmApiKeySet=!!state.settings.llmApiKey, imageApiKeySet=!!state.settings.imageApiKey;
    state.settings.apiKey = "";state.settings.llmApiKey='';state.settings.imageApiKey='';
    return { ...state, apiKeySet, llmApiKeySet, imageApiKeySet };
  }
  save() {
    this.state.revision++;
    const safe = structuredClone(this.state);
    safe.settings.apiKey = "";safe.settings.llmApiKey="";safe.settings.imageApiKey="";
    const json = JSON.stringify(safe);
    this.db.run("BEGIN");
    try {
      this.db.run("INSERT OR REPLACE INTO workspace VALUES(1,?)", [json]);
      this.db.run("INSERT INTO revisions(created,json) VALUES(?,?)", [
        now(),
        json,
      ]);
      this.db.run(
        "DELETE FROM revisions WHERE id NOT IN (SELECT id FROM revisions ORDER BY id DESC LIMIT 30)",
      );
      this.db.run("COMMIT");
    } catch (e) {
      this.db.run("ROLLBACK");
      throw e;
    }
    atomicWrite(this.file, this.db.export());
    atomicWrite(
      path.join(this.state.settings.dataDir, "secrets.json"),
      JSON.stringify({ apiKey: this.state.settings.apiKey, llmApiKey:this.state.settings.llmApiKey,imageApiKey:this.state.settings.imageApiKey }),
    );
  }
  mutate(fn: (state: WorkspaceState) => void) {
    const before = structuredClone(this.state);
    try {
      fn(this.state);
      this.save();
    } catch (e) {
      this.state = before;
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
