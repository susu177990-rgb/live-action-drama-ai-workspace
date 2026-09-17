# 第一版验收记录

2026-09-09。

- tests.tap：27 项 Node 自动测试，包含真实 FFmpeg、多媒体格式、API 契约、任务中断恢复、版本依赖、候选批准和 HTTP 安全边界。
- media-smoke.json：读取 EP1-A 原片截取 6 秒，隔离验证导入、组段、人工 Take、对齐与原声导出。测试 Take 是原片副本，非 AI 结果。
- ui-smoke.json：生产前端双屏真实播放、设置、批注保存与切换。一次观测两播放器同为0.745999秒，不代表任意素材永远帧级同步。
- timeline-smoke.json：浏览器真实交互验收拆分、拖动重排、裁剪、撤销、锚点编辑与确认、成片范围持久化、重载恢复。
- ../ai-evidence/：Codex 真实文本与单次真实生图的证据；未调用真实 Seedance。

截图为隔离验收数据，不是正式项目成片。失败调试截图不作为通过证据。视频账号接入、真实视频生成质量和真实参考图编辑质量需要后续凭证及制作样本验收。

Electron 桌面启动已实测通过（electron-smoke.json、electron-start.png）。运行时下载后按 Electron npm 包中的 SHA-256 校验，使用真实 Electron 44.3.0 启动本地服务与界面。
