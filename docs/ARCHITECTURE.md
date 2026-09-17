# 实现与维护

Renderer 只访问本机 HTTP API，Electron 禁用 Node 集成并启用沙箱与上下文隔离。服务只绑定 127.0.0.1，校验 Host、Origin、Sec-Fetch-Site，API 和媒体需要 SameSite=Strict 的 HttpOnly 会话 Cookie。素材 URL 由资产 ID 解析，不接受任意文件路径。

SQLite 使用 sql.js，由本地服务单独持有。每次提交先完成 SQLite 事务，再将数据库写入临时文件、fsync、原子重命名；单实例锁阻止多进程写同一数据目录。图片、视频候选保存到唯一文件名，不覆盖原片或旧版本。

时间单位为秒，范围左闭右开。Shot 保存源文件时间；Segment.clips 保存拼接选择；Take.sourceClips/sourceAssetId 保存生成时源片快照；Alignment 保存段内原片与生成片的独立时间。原片时间、请求时间和生成结果时间不能混用。

Job 的未知提交是独立状态：网络错误或服务端不确定响应不能自动重试 POST。已经有 remoteId 时只恢复 GET 查询。配置与参考输入在排队时冻结，提交前检查镜头版本；生成结果保留输入版本，旧版本不覆盖新结果。

Codex 调用通过参数数组和 stdin，不拼接 shell。工作目录为工作台输出目录；附图使用 CLI -i；结构化结果使用 --output-schema。图像完成必须读取实际文件，不能只信自然语言“已生成”。

Seedance 通过独立 adapter：Files 上传 → download_url → content 引用 → POST 任务 → GET 状态 → 下载落盘。图片/音频可使用官方支持的内联 data URI。日志不保存 API Key，请求清单不保存 Base64 全量数据或签名 URL 查询参数。

后续优先事项：拿到凭证后做单次真实视频端到端验收；根据实片评估视觉/音频特征匹配对齐；独立长任务进程和增量数据库事务；可移植项目包；按真实发行需求增加应用签名与安装包。
