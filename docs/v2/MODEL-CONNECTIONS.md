# 模型连接与模式（2026-09-15）

API 设置上方统一管理 Codex 登录和连接。`codex.connection.status` 执行 CLI 登录与能力检查；`codex.connection.connect` 在未登录时启动官方 `codex login` 浏览器授权，随后发送最小文本请求，只有收到 WORKBENCH_OK 才标记连接成功。登录链接仅驻留后端内存，经本机已认证会话显示；不读取或导出 Codex 认证文件。授权与测试支持停止，180 秒超时，不自动重试。连接状态是最近测试结果，不代表后续任务必然成功。

LLM 和生图的 `codex/custom` 模式独立保存。默认均为 Codex；自定义 LLM 使用 `/chat/completions`，传入文字、图片 data URL 和所需 JSON Schema；生图转绘使用 `/images/edits` multipart 多图，纯文生图使用 `/images/generations`。API 必须兼容对应协议与模型能力，并非任意厂商协议通用。返回图片校验格式后保存为独立候选，批准流程不变。自定义调用失败不回退至 Codex，不自动重试。视频链路不变。

自定义 LLM 和生图分别填写完整 Base URL（通常包含服务商要求的版本路径，例如 `/v1`）；工作台会按用途补齐对应的请求路径。视频 API 继续使用独立的 API Base URL。三类密钥分别保存于本机 secrets.json（0600），数据库、版本历史、公开 state 不包含密钥。空白输入保留已有密钥。API 地址与模型按用途分别保存。

## 验收

- `npm run check`；完整 40 项测试通过；新适配器、密钥隔离、登录流程及 Service 路由测试使用本机假服务/假 CLI。
- `scripts/settings-ui-smoke.mjs`：隔离状态验证独立模式、切换保留草稿、密钥留空保存。
- `scripts/codex-connection-live.mjs`：真实浏览器点击连接按钮 → 真实后端 → 本机已登录 Codex → WORKBENCH_OK。该脚本会调用真实模型，不用于普通自动验收。
- 当前真实账号已经登录，所以从未登录到浏览器完成授权的分支只通过假 CLI 合约验证，未退出用户账号重新登录。
- 本次没有调用真实生图或自定义供应商；自定义 API 实际供应商仍待用户填写配置后验证。未恢复正式集数分析。

## 官方接口依据

- https://developers.openai.com/codex/auth
- https://platform.openai.com/docs/api-reference/chat/create
- https://platform.openai.com/docs/api-reference/images/createEdit
