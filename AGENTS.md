# 与光实拍工作台开发约定

开发目录仅限本工作台。不要修改兄弟目录内的原视频、剧本、资产、原始帧或正式分镜图。测试素材使用 .workbench/verification-*，不可伪装成 AI 成功生成。

- 主工作流和接口见 docs/CONTRACT.md；架构见 docs/ARCHITECTURE.md。
- 生产服务只绑定本机。保持媒体路由的 ID 白名单、会话 Cookie 与跨站校验；.workbench 隐藏目录内的授权媒体需要 sendFile({dotfiles:'allow'})。
- Codex 用已登录 CLI，不读取认证文件。正式生成文件必须实际存在，不能只凭最终文本认定成功。
- Seedance 没有真实 Key 的验收仍未完成。当前请求契约与证据见 docs/AI-INTEGRATION.md；不要将假服务测试写成线上接通。
- 候选须人工批准。镜头事实改动使下游过期；Take 保留历史 sourceClips/sourceAssetId，不能拿当前剪辑替换历史对应关系。
- 视频 POST 结果未知时禁止自动重试；remoteId 与 resultId 持久化后恢复查询/对齐，不重复消费。
- 每次改动运行 npm test、npm run build。交互改动按需运行 scripts/ui-smoke.ts、scripts/timeline-smoke.ts；均不调用收费模型。
- 数据库和 secrets.json 不纳入版本控制或普通项目 JSON 导出。备份应退出后复制整个 .workbench。

## 当前开发流程
- 默认浏览器开发预览：http://127.0.0.1:5173（Vite 热更新），本地 API 为 4318。
- 界面小改用浏览器验证及必要类型检查，不每次构建/打包/重启 Electron；桌面交付或用户明确要求时再构建。
