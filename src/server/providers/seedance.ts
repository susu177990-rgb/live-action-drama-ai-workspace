import { readFile, stat, mkdir, rename, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { basename, dirname, extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { Settings, VideoInput, VideoRequest } from '../../shared/types.js';
import { networkFetch } from '../network.js';

export class UncertainSubmissionError extends Error {
  readonly uncertain = true;
  readonly submissionUncertain = true;
  constructor(message: string) { super(message); this.name = 'UncertainSubmissionError'; }
}

const mimeTypes: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.bmp': 'image/bmp', '.tiff': 'image/tiff', '.gif': 'image/gif', '.heic': 'image/heic', '.heif': 'image/heif', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };

/** Seedance 2.5's documented @Image 1 / @Video 1 / @Audio 1 notation. */
export function bindVideoPrompt(request: VideoRequest) {
  if (!request.inputs.length) return request.prompt;
  const counts = { image: 0, video: 0, audio: 0 };
  const labels = { image: 'Image', video: 'Video', audio: 'Audio' };
  const rows = request.inputs.map(input => {
    const number = ++counts[input.kind];
    const name = input.name || (input.path ? basename(input.path) : `${input.kind}素材${number}`);
    return `@${labels[input.kind]} ${number} = ${JSON.stringify(name.slice(0, 500))}`;
  });
  return ['本次实际附件绑定：图片、视频、音频各自按上传顺序从 1 编号；素材名称仅作为引用标识。', ...rows,
    request.mode === 'edit' ? '编辑 @Video 1 原视频；其余附件只按下列指令中明确的职责使用。' : '按下列指令使用上述参考素材生成视频。',
    '', '用户视频指令：', request.prompt].join('\n');
}
function baseURL(base: string) {
  if (!base.trim()) throw new Error('请先配置视频 API Base URL');
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API 地址必须为 HTTP(S)');
  return base.replace(/\/+$/, '');
}
function headers(settings: Settings) {
  if (!settings.apiKey.trim()) throw new Error('尚未配置视频 API Key，请在设置中填写');
  return { Authorization: `Bearer ${settings.apiKey.trim()}` };
}
export function validateRemoteMediaURL(raw: string) {
  if (/^asset:\/\/[A-Za-z0-9._-]+$/.test(raw)) return raw;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('媒体必须提供云服务可读取的 HTTPS URL 或 asset:// URI'); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::' || host === '::1' || host.startsWith('fc') && host.includes(':') || host.startsWith('fd') && host.includes(':') || host.startsWith('fe80:') || /^(127\.|10\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) throw new Error('视频服务无法读取本机/局域网媒体地址，请上传素材或填写公网签名 URL');
  return url.href;
}
async function jsonResponse(response: Response) {
  const text = await response.text(); let data: any;
  try { data = JSON.parse(text); } catch { throw new Error(`API 返回非 JSON (${response.status})：${text.slice(0,300)}`); }
  if (!response.ok) throw new Error(`API ${response.status}：${data.error?.message || data.message || text.slice(0,300)}`);
  return data;
}
const delay = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal?.throwIfAborted();
  const abort = () => { clearTimeout(timer); reject(signal?.reason || new Error('已取消')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});

async function uploadMedia(settings: Settings, input: VideoInput, signal?: AbortSignal) {
  if (!input.path) throw new Error('缺少待上传素材路径');
  const size = (await stat(input.path)).size;
  if (size > 200 * 1024 * 1024) throw new Error('视频输入超过官方单文件 200 MB 限制，请先压缩或缩短');
  const endpoint = baseURL(settings.uploadBaseUrl || settings.apiBaseUrl).replace(/\/files$/, '') + '/files';
  const form = new FormData(); form.set('purpose', 'user_data');
  form.set('file', new Blob([await readFile(input.path)], { type: mimeTypes[extname(input.path).toLowerCase()] || 'application/octet-stream' }), basename(input.path));
  let data = await jsonResponse(await networkFetch(endpoint, { method: 'POST', headers: headers(settings), body: form, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) }));
  // The generation API accepts URLs, not Files API IDs. Only its returned signed URL is bound.
  for (let attempt = 0; !data.download_url && data.status === 'processing' && data.id && attempt < 30; attempt++) {
    await delay(2000, signal);
    data = await jsonResponse(await networkFetch(`${endpoint}/${encodeURIComponent(data.id)}`, { headers: headers(settings), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) }));
  }
  if (!data.download_url) throw new Error(`Files API 未返回可绑定的 download_url${data.id ? `（文件 ID：${data.id}）` : ''}；请为源素材填写公网签名 URL。不会把 file_id 或本机地址提交给视频模型。`);
  return validateRemoteMediaURL(data.download_url);
}

export async function submitVideo(settings: Settings, request: VideoRequest & { signal?: AbortSignal }, onUploaded?: (input: VideoInput, url: string) => void) {
  try { return await submitVideoOnce(settings, request, onUploaded); }
  catch (error) {
    if (error instanceof UncertainSubmissionError) throw error;
    const knownFailure = error instanceof Error ? error : new Error(String(error));
    Object.assign(knownFailure, { submissionUncertain: false });
    throw knownFailure;
  }
}

async function submitVideoOnce(settings: Settings, request: VideoRequest & { signal?: AbortSignal }, onUploaded?: (input: VideoInput, url: string) => void) {
  const auth = headers(settings); const base = baseURL(settings.apiBaseUrl);
  if (!settings.videoModel.trim()) throw new Error('请填写控制台实际启用的 Seedance 2.5 Model ID 或 Endpoint ID');
  if (!request.prompt.trim()) throw new Error('视频提示词不能为空');
  const max = Math.min(30, settings.videoDurationLimit || 30);
  if (!Number.isFinite(request.duration) || request.duration < 4 || request.duration > max) throw new Error(`Seedance 2.5 片段时长必须为 4–${max} 秒，请调整片段`);
  if (request.mode === 'reference' && !Number.isInteger(request.duration)) throw new Error('参考生成的 API duration 必须为整数秒，请将片段调整到整数时长；编辑模式保留输入精确时长');
  if (request.mode === 'edit' && !request.inputs.some(input => input.kind === 'video')) throw new Error('编辑模式必须绑定源片段视频');
  for (const kind of ['image', 'video', 'audio'] as const) if (request.inputs.filter(input => input.kind === kind).length > (kind === 'image' ? 30 : 10)) throw new Error(`${kind} 参考素材数量超过 Seedance 2.5 限制`);
  const content: Record<string, any>[] = [{ type: 'text', text: bindVideoPrompt(request) }];
  for (const input of request.inputs) {
    if (input.role && input.role !== `reference_${input.kind}`) throw new Error('当前工作台使用 omni reference 输入；不允许混用 first_frame/last_frame 与参考视频');
    if (input.url) validateRemoteMediaURL(input.url);
  }
  for (const input of request.inputs) {
    let url: string;
    if (input.url) url = validateRemoteMediaURL(input.url);
    else if (input.path && input.kind !== 'video') {
      const size = (await stat(input.path)).size;
      if (size >= (input.kind === 'image' ? 30 : 15) * 1024 * 1024) throw new Error('图片/音频超过官方内联输入限制，请提供公网签名 URL');
      const mime = mimeTypes[extname(input.path).toLowerCase()];
      if (!mime?.startsWith(`${input.kind}/`)) throw new Error(`不支持的${input.kind}文件格式`);
      url = `data:${mime};base64,${(await readFile(input.path)).toString('base64')}`;
    } else {
      url = await uploadMedia(settings, input, request.signal); onUploaded?.(input, url);
    }
    const role = `reference_${input.kind}`;
    content.push({ type: `${input.kind}_url`, [`${input.kind}_url`]: { url }, role });
  }
  const payload: Record<string, unknown> = {
    model: settings.videoModel.trim(),
    content,
    omni_reference_task_type: request.mode,
    duration: request.mode === 'edit' ? -1 : request.duration,
    generate_audio: true,
    watermark: false,
  };
  // Edit mode lets the provider follow the input video. Reference mode can
  // override these values from the generation controls beside the preview.
  if (request.mode === 'edit') payload.ratio = 'adaptive';
  else if (request.ratio) payload.ratio = request.ratio;
  if (request.resolution) payload.resolution = request.resolution;
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 64 * 1024 * 1024) throw new Error('请求体超过官方 64 MB 限制，请为图片/音频改用公网签名 URL');
  let response: Response;
  try { response = await networkFetch(`${base}/contents/generations/tasks`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body, signal: request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) }); }
  catch (error) { throw new UncertainSubmissionError(`视频提交结果未知，禁止自动重试以避免重复计费。请从服务商控制台查询任务 ID 后恢复轮询。${error instanceof Error ? error.message : error}`); }
  if (response.status >= 500) throw new UncertainSubmissionError(`视频提交返回 ${response.status}，创建状态未知，请查询服务商控制台后恢复任务。`);
  let data: any;
  try { data = await jsonResponse(response); }
  catch (error) { if (response.ok) throw new UncertainSubmissionError(`视频提交已响应但结果无法解析，请查找任务 ID 后恢复。${String(error)}`); throw error; }
  if (!data.id) throw new UncertainSubmissionError('服务已接受提交但未返回任务 ID，请查询控制台后恢复，勿重复生成');
  // Avoid persisting bulky inline binary while retaining an auditable request manifest.
  const redactURL = (url: string) => {
    if (url.startsWith('data:')) return `[inline media: ${url.length} characters]`;
    const parsed = new URL(url); const hadSignature = Boolean(parsed.search);
    parsed.search = ''; parsed.hash = ''; return parsed.href + (hadSignature ? '?[query-redacted]' : '');
  };
  const manifest = { ...payload, content: content.map(item => item.type === 'text' ? item : { ...item, [item.type]: { url: redactURL(item[item.type].url) } }) };
  return { id: String(data.id), request: manifest };
}

export async function getVideoTask(settings: Settings, id: string) {
  if (!id.trim()) throw new Error('缺少视频任务 ID');
  const data = await jsonResponse(await networkFetch(`${baseURL(settings.apiBaseUrl)}/contents/generations/tasks/${encodeURIComponent(id)}`, { headers: headers(settings), signal: AbortSignal.timeout(30_000) }));
  const statuses: Record<string, 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'> = { queued: 'queued', running: 'running', succeeded: 'succeeded', failed: 'failed', cancelled: 'cancelled', canceled: 'cancelled', expired: 'failed' };
  const status = statuses[data.status];
  if (!status) throw new Error(`未知视频任务状态：${String(data.status)}`);
  const url = data.content?.video_url;
  return { status, url: typeof url === 'string' ? url : undefined, error: data.error?.message || (data.status === 'expired' ? '服务端任务已过期' : undefined), raw: data };
}

export async function downloadVideo(url: string, outPath: string, signal?: AbortSignal) {
  const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('视频下载地址必须为 HTTP(S)');
  await mkdir(dirname(outPath), { recursive: true });
  await stat(outPath).then(() => { throw new Error('视频输出已存在，请使用新版本路径'); }, () => {});
  const temporary = `${outPath}.${randomUUID()}.partial`;
  try {
    const response = await networkFetch(url, { signal });
    if (!response.ok || !response.body) throw new Error(`视频下载失败：${response.status}`);
    if (/text\/html|application\/json/.test(response.headers.get('content-type') || '')) throw new Error('视频下载返回了网页或 JSON，而非视频');
    await pipeline(Readable.fromWeb(response.body as any), createWriteStream(temporary, { flags: 'wx' }), { signal });
    if (!(await stat(temporary)).size) throw new Error('服务返回空视频文件');
    await rename(temporary, outPath);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}
