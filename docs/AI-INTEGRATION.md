# AI 适配与验证记录

验证日期：2026-09-09。生产实现为 `src/server/ai.ts` 和 `src/server/providers/seedance.ts`，没有演示返回值或生成失败后替换成假图/假视频的分支。

## Codex 文本和图像

使用本机 `/Applications/ChatGPT.app/Contents/Resources/codex`，实测版本 `codex-cli 0.153.4`，沿用已保存的 ChatGPT 登录，无需额外 OpenAI API Key。配置中的 Codex 路径和模型可修改；模型为空时沿用本机默认。实际烟测观察到的模型为 `gpt-6-astra`。

命令通过 `spawn` 参数数组与 stdin 传递，不执行拼接 shell：全局 `-a never`，然后 `exec --json --skip-git-repo-check -s workspace-write -C <任务目录> -o <唯一输出文件>`。需要结构化结果时附加 `--output-schema`；本地参考图用独立 `-i <绝对路径>` 参数附加。图像任务启用内置 `image_generation`，要求一次生成一个候选、不自动重试，并默认使用 `status/image_path` JSON 输出。不会切换到需要 API Key 的 Python 绘图客户端。

`checkCodex` 是无推理消耗的本机版本、登录、功能开关检查；开关启用本身不等于某次生成成功。`runCodex` 保存文本与 JSONL 事件，解析结构化响应，读取真实图片后复制到任务输出目录的唯一版本路径。PNG/JPEG/WebP 文件头会校验；没有可读取的图片就报错。源参考图不当作生成结果返回，已有输出不覆盖。

实测 `exec --json` 没有输出 `imageGeneration.savedPath` 事件，虽然 app-server 协议定义了该字段。因此实现同时支持 `savedPath` / `saved_path` 与最终 JSON/Markdown 中的实际绝对路径。不能只依赖图像事件完成导入。

已完成的真实调用只有两次：

1. 一次极短文本调用，返回 `CODEX_TEXT_OK`。
2. 一次带输出 JSON Schema 的内置图像生成，返回 `status=generated` 与真实图片路径。原始 rollout 记录证明内置 `tools.image_gen__imagegen` 恰好调用一次；实际产物为 1254×1254 PNG（900,452 字节），已打开检查为灰底蓝色陶瓷杯。要求使用最低可用质量/最小尺寸，实际输出尺寸由工具决定；这只是接通测试，不是生产分镜或质量样板。

证据保存在 [ai-evidence/real-smoke-summary.json](ai-evidence/real-smoke-summary.json)、[文本事件](ai-evidence/text-events.jsonl)、[图像事件](ai-evidence/image-events.jsonl)、[JSON Schema](ai-evidence/image-schema.json)、[结构化结果](ai-evidence/image-result.json) 与 [实际 PNG](ai-evidence/codex-image-smoke.png)。摘要保留实际工具调用、产物 SHA-256 和验证范围；未把整份含大量上下文和 Base64 的 rollout 复制入项目。

参考图编辑的 `-i` 传递与读取结果经过本地契约测试，**没有再次调用真实编辑服务**，以遵守本次额度节制要求。文本分析/提示词生成需要模型成功返回；确定性编译器是用户可继续编辑的底稿，不能冒充已经执行过视觉分析。

本机 CLI 烟测报告了用户 hooks 配置 `unknown field state` 和技能描述截短的警告，但两次调用均正常完成。工作台不会修改用户全局 hooks 或登录配置。

## Seedance 2.5

截至本次验证，用户没有视频 API Key，因此**没有真实提交、扣费或产出 Seedance 视频**。已实现的上传、提交、查询、下载链路通过官方字段核对及本地 HTTP 契约测试；本地测试服务器不是服务商接通证明。

配置字段：

| 设置 | 约定 |
| --- | --- |
| API Base URL | 官方 BytePlus 示例为 `https://ark.ap-southeast.bytepluses.com/api/v3`；可填账号实际对应地域或兼容服务地址 |
| API Key | 本机设置中保存；仅用于 Bearer 鉴权，不进入请求审计清单 |
| Video Model | 用户填写控制台实际启用的 Model ID / Endpoint ID；官方当前示例为 `dreamina-seedance-2-5-260628`，不假设所有账号均已开通 |
| Upload Base URL | 为空时使用 API Base URL；填写时应是兼容官方 `/files` 的基地址，可带 `/files` 后缀 |
| Mode | `edit` 编辑原片或 `reference` 参考生成 |

提交端点为 `POST /contents/generations/tasks`。每个输入使用 `type=image_url/video_url/audio_url`，嵌套同名 `{url}`，并指定 `reference_image/reference_video/reference_audio`。不混用 `first_frame/last_frame` 与 omni 参考输入。

实际提交文本会在原提示词前加入按附件顺序生成的绑定表，例如 `@Video 1 = "原视频"`、`@Image 1 = "日景场景"`；各媒体类型独立编号。使用官方教程的 `@Image 1 / @Video 1 / @Audio 1` 引用方法，不新增未支持的 JSON 属性。用户编辑的原提示词完整保留在表后。

- 编辑模式传 `omni_reference_task_type: "edit"`、`ratio: "adaptive"`、`duration: -1`；必须有原视频，输入时长 4–30 秒。保留输入的实际非整数时长，不擅自裁成整数秒。
- 参考生成传 `omni_reference_task_type: "reference"`；输出 `duration` 必须为 4–30 的整数秒，遵守用户配置的更小上限。
- 官方 2.5 参考数量上限是图片 30、视频 10、音频 10；视频累计时长、分辨率、编码等仍须由实际输入检查与服务商校验共同确认。当前工作台的主源片段由本地媒体模块准备。
- 本地图片/音频以官方支持的 `data:<mime>;base64,...` 传入，检查单文件和请求体大小。视频不使用未获官方确认的 Base64 方式，也不把 `/media/...`、localhost 或局域网地址发给云端。
- 官方参考音频格式是 WAV / MP3。工作台可导入供本地使用的 M4A / AAC / FLAC 不代表可直接提交为模型参考；这三种格式须先转换为 WAV 或 MP3。提供公网 URL 同样不会扩大官方支持的音频格式范围，当前适配器不静默转码。
- 本地视频使用官方 Files API：`POST /files`，multipart 字段 `file` 与 `purpose=user_data`。读取响应 `download_url`（服务端签名的 TOS 对象地址），必要时短暂查询 `GET /files/:id`，然后把返回的真实 URL 绑定为 `video_url.url`。Files API 的 `file_id` 不能直接当视频生成的 URL。若账号/地域的 Files API 没有返回 `download_url`，任务明确停止并要求为素材设置服务商可读取的公网签名 URL。此“Files 返回签名 URL → 生成输入 URL”组合使用官方文档字段，但尚无本账号线上联调证据。
- 用户已有的公网签名 URL 或官方 `asset://...` 可以直接绑定。实际上传后的 URL 通过回调交给任务服务保存；请求审计清单剔除 URL 查询参数及全部内联 Base64。

创建任务只 POST 一次。校验失败、上传失败、明确 HTTP 4xx 返回 `submissionUncertain=false`；创建请求的网络异常、HTTP 5xx、成功响应无法解析或没有 ID 返回 `submissionUncertain=true`。后一类必须先到服务商控制台找到任务 ID 后恢复轮询，不能自动重发并重复计费。拿到 ID 后使用 `GET /contents/generations/tasks/:id`；成功时读取 `content.video_url` 并原子下载，拒绝空文件或 HTML/JSON 响应。中止后保留远端 ID，查询恢复不重新创建任务。

官方依据：

- [创建视频生成任务](https://docs.byteplus.com/en/docs/ModelArk/1520757)：2.5 任务字段、edit 模式限制、输入格式与数量、大小限制。
- [Seedance 2.5 教程](https://docs.byteplus.com/en/docs/ModelArk/2607688)：当前 2.5 工作流与示例，页面更新于 2026-09-08。
- [上传文件](https://docs.byteplus.com/en/docs/ModelArk/1870405)：multipart 文件、purpose、文件状态、download_url。
- [Seedance 2.5 官方发布页](https://seed.bytedance.com/en/seedance2_5)：30 秒叙事及编辑、参考控制能力。
- [Codex 非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode) 与 [图像生成](https://learn.chatgpt.com/docs/image-generation)：集成背景；具体参数以本机 0.153.4 `--help` 和实际调用为准。

## 提示词与验证边界

`compileEpisode` 仅纳入当前集事实、资产与镜头；未知项写待确认。`compileSegment` 逐段累计片段内时间码，同时保留源文件绝对时间码追溯，包含原动作/构图/接触约束、当前视觉要求和用户可编辑的全片提示词。生成候选必须通过 Take 的批准状态检查后才进入参考；正式镜头绑定还须匹配本次镜头事实版本。跨集资产、未批准候选和缺失源片段不会静默带入。

`npx tsx --test tests/ai.test.ts tests/video-job.test.ts` 检查事实与批准范围、片段本地时间、CLI 参数/结构化结果/真实文件读取、Files→任务创建→查询→下载请求契约、提交不确定性、localhost 输入拒绝以及附件独立编号。服务级测试用 ffmpeg 创建带原声的真实四秒 MP4，验证批准门槛、上传后只提交一次、实际下载、提交时镜头快照、自动对齐以及重启后从未知提交恢复且不重复 POST。测试使用显式标识的假 CLI/HTTP 服务，无模型调用或网络计费。

尚未验证的生产边界：真实参考图编辑的身份/构图保持质量；用户视频账号权限、区域 URL、实际 Model ID；真实 Files 上传与 Seedance 生成联通；真实生成视频的时序/对白/画面质量。工作台必须把这些运行失败与候选审查结果展示给用户，不可将接口契约测试标成生产通过。
