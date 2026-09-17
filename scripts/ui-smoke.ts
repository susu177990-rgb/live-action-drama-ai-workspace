import { chromium, _electron as electron } from "@playwright/test";
import { readFile, mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../src/server/index.js";
const evidence = JSON.parse(
  await readFile("docs/verification/media-smoke.json", "utf8"),
);
const runtime = await startServer({
  dataDir: evidence.dataDir,
  port: 4318,
  staticDir: path.resolve("dist"),
});
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const apiErrors: string[] = [];
page.on("response", (r) => {
  if (r.status() >= 400 && /\/api\//.test(r.url()))
    apiErrors.push(`${r.status()} ${r.url()}`);
});
try {
  await page.goto(runtime.url);
  await page.getByRole("button", { name: "设置", exact: true }).waitFor();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .first()
    .click();
  await page.screenshot({
    path: "docs/verification/workbench-shots.png",
    fullPage: true,
  });
  // Choose the persisted real-media test segment from the library.
  await page.getByText("生成段 1", { exact: true }).first().click();
  await page.getByRole("button", { name: "播放", exact: true }).click();
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  const videoTimes = await page
    .locator(".viewer video")
    .evaluateAll((videos) =>
      videos.map((v) => ({
        time: (v as HTMLVideoElement).currentTime,
        ready: (v as HTMLVideoElement).readyState,
        error: (v as HTMLVideoElement).error?.message,
      })),
    );
  if (
    videoTimes.length !== 2 ||
    videoTimes.some((v) => v.time <= 0.1 || v.error)
  )
    throw new Error("双屏视频没有有效播放：" + JSON.stringify(videoTimes));
  await page.getByRole("button", { name: /审片与交付/ }).click();
  await page
    .getByRole("textbox", { name: "审片批注" })
    .fill("浏览器验收：双屏播放与本地保存正常");
  await page.getByRole("button", { name: /保存批注|添加批注/ }).click();
  await page.getByRole("button", { name: /视频生成/ }).click();
  await page.screenshot({
    path: "docs/verification/workbench-video.png",
    fullPage: true,
  });
  if (errors.length || apiErrors.length)
    throw new Error(JSON.stringify({ errors, apiErrors }));
  await writeFile(
    "docs/verification/ui-smoke.json",
    JSON.stringify(
      {
        passed: true,
        videoTimes,
        errors,
        apiErrors,
        checked: [
          "真实素材双屏播放",
          "设置弹窗",
          "审片批注保存",
          "生成段切换",
          "生产构建渲染",
        ],
      },
      null,
      2,
    ),
  );
  console.log("Browser UI passed", JSON.stringify(videoTimes));
} catch (error) {
  await page.screenshot({
    path: "docs/verification/ui-failure.png",
    fullPage: true,
  });
  console.log(await page.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
  await runtime.close();
}
// Desktop launch verifies the built server runs inside Electron without native ABI issues.
const desktopDir = await mkdtemp(path.join(tmpdir(), "workbench-electron-"));
try {
  const app = await electron.launch({
    args: [path.resolve(".")],
    env: { ...process.env, WORKBENCH_DATA_DIR: desktopDir },
  });
  const window = await app.firstWindow();
  await window
    .getByRole("button", { name: "设置", exact: true })
    .waitFor({ timeout: 30000 });
  await window.screenshot({ path: "docs/verification/electron-start.png" });
  await app.close();
  console.log("Electron desktop launch passed");
  await writeFile(
    "docs/verification/electron-smoke.json",
    JSON.stringify(
      { passed: true, checked: "真实 Electron 启动并渲染本地界面" },
      null,
      2,
    ),
  );
} finally {
  await rm(desktopDir, { recursive: true, force: true });
}
