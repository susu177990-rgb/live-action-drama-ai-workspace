import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, link, stat, unlink } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import type { Alignment, MediaClip, MediaInfo, MediaOptions } from '../shared/types.js';

type ProcessOptions = Pick<MediaOptions, 'signal'> & {
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (line: string) => void;
  captureStdout?: boolean;
};

function aborted(): Error {
  const error = new Error('媒体处理已取消');
  error.name = 'AbortError';
  return error;
}

function finite(value: number, name: string, minimum = 0, maximum = Infinity): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name}必须是 ${minimum} 至 ${maximum === Infinity ? '有限上限' : maximum} 范围内的数字`);
  }
  return value;
}

function seconds(value: number): string { return value.toFixed(9); }
function rounded(value: number): number { return Number(value.toFixed(6)); }

/** Spawn argument arrays only. Keep diagnostics bounded and always reap cancelled children. */
async function run(executable: string, args: string[], options: ProcessOptions = {}): Promise<string> {
  if (options.signal?.aborted) throw aborted();
  if (!executable?.trim()) throw new Error('未配置媒体工具可执行文件');
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let diagnostics = '';
    let partialLine = '';
    let processError: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1500);
      killTimer.unref();
    };
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        options.onStdout?.(chunk);
        if (options.captureStdout !== false) {
          stdout += chunk.toString('utf8');
          if (stdout.length > 4 * 1024 * 1024) throw new Error('媒体工具返回数据超出安全上限');
        }
      } catch (error) { processError = error as Error; cancel(); }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      diagnostics = (diagnostics + text).slice(-24_000);
      partialLine += text;
      const lines = partialLine.split(/\r?\n/);
      partialLine = lines.pop()!.slice(-24_000);
      try { for (const line of lines) options.onStderr?.(line); }
      catch (error) { processError = error as Error; cancel(); }
    });
    child.on('error', error => { processError = new Error(`无法运行媒体工具 ${executable}: ${error.message}`); });
    child.on('close', code => {
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', cancel);
      if (options.signal?.aborted) return reject(aborted());
      if (processError) return reject(processError);
      if (code !== 0) return reject(new Error(`媒体工具执行失败（${code ?? 'signal'}）：${diagnostics.trim() || executable}`));
      accept(stdout);
    });
  });
}

/** Publish complete files atomically without replacing a previous candidate. */
async function outputFile(outPath: string, options: MediaOptions, write: (temporary: string) => Promise<void>): Promise<void> {
  if (options.signal?.aborted) throw aborted();
  const destination = resolve(outPath);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = join(dirname(destination), `.media-${randomUUID()}${extname(destination) || '.mp4'}`);
  try {
    await write(temporary);
    if (options.signal?.aborted) throw aborted();
    const result = await stat(temporary);
    if (result.size === 0) throw new Error('媒体工具未生成有效文件');
    await link(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function rational(value: unknown): number {
  if (typeof value !== 'string' && typeof value !== 'number') return 0;
  const [n, d = '1'] = String(value).split('/');
  const result = Number(n) / Number(d);
  return Number.isFinite(result) && result > 0 ? result : 0;
}

export async function probe(path: string, options: MediaOptions): Promise<MediaInfo> {
  const text = await run(options.ffprobePath, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', resolve(path)], options);
  const data = JSON.parse(text) as { format?: { duration?: string; format_name?: string }; streams?: Array<Record<string, any>> };
  const streams = data.streams ?? [];
  const video = streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audio = streams.find(stream => stream.codec_type === 'audio');
  if (!video && !audio) throw new Error('文件不包含可解码的视频、图片或音频');
  const streamDuration = Math.max(0, ...streams.map(stream => rational(stream.duration) || rational(stream.duration_ts) * rational(stream.time_base)));
  const duration = rational(data.format?.duration) || streamDuration;
  const isImage = !!video && !audio && /(?:^|,)(?:image2|image2pipe|\w+_pipe)(?:,|$)/.test(data.format?.format_name ?? '');
  let width = Number(video?.width) || 0;
  let height = Number(video?.height) || 0;
  const rotation = Number(video?.side_data_list?.find((item: Record<string, unknown>) => item.rotation !== undefined)?.rotation ?? video?.tags?.rotate ?? 0);
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  return { duration: isImage ? 0 : duration, width, height, fps: isImage ? 0 : rational(video?.avg_frame_rate) || rational(video?.r_frame_rate), hasAudio: !!audio, kind: isImage ? 'image' : video ? 'video' : 'audio' };
}

export async function createProxy(path: string, outPath: string, options: MediaOptions): Promise<void> {
  const info = await probe(path, options);
  if (info.kind !== 'video') throw new Error('预览代理只支持视频素材');
  options.onProgress?.('正在转码浏览器预览代理');
  await outputFile(outPath, options, temporary => run(options.ffmpegPath, [
    '-hide_banner', '-nostdin', '-nostats', '-v', 'error', '-n', '-i', resolve(path),
    '-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-f', 'mp4', temporary,
  ], options).then(() => undefined));
}

export async function extractFrame(path: string, time: number, outPath: string, options: MediaOptions): Promise<void> {
  finite(time, '帧时间');
  const info = await probe(path, options);
  if (info.kind !== 'video' && info.kind !== 'image') throw new Error('素材没有可提取的画面');
  if (info.kind === 'video' && time > info.duration + 0.001) throw new Error('帧时间超出素材时长');
  const target = info.kind === 'image' ? 0 : Math.min(time, Math.max(0, info.duration - 1 / (info.fps || 25)));
  const png = extname(outPath).toLowerCase() === '.png';
  await outputFile(outPath, options, temporary => run(options.ffmpegPath, [
    '-hide_banner', '-nostdin', '-nostats', '-v', 'error', '-n', '-ss', seconds(target), '-i', resolve(path),
    '-map', '0:v:0', '-frames:v', '1', '-an', '-c:v', png ? 'png' : 'mjpeg', ...(png ? [] : ['-q:v', '2']), '-f', 'image2', '-update', '1', temporary,
  ], options).then(() => undefined));
}

export async function sceneDetect(path: string, options: MediaOptions & { threshold?: number; minDuration?: number }): Promise<number[]> {
  const threshold = finite(options.threshold ?? 0.32, '切点阈值', 0.001, 1);
  const minimum = finite(options.minDuration ?? 0.45, '最短镜头时长', 0.01);
  const info = await probe(path, options);
  if (info.kind !== 'video') throw new Error('切点检测只支持视频素材');
  const cuts: number[] = [];
  options.onProgress?.('正在按画面变化检测切点');
  await run(options.ffmpegPath, [
    '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info', '-i', resolve(path),
    '-vf', `setpts=PTS-STARTPTS,select='gt(scene,${threshold})',showinfo`, '-an', '-sn', '-f', 'null', '-',
  ], { signal: options.signal, onStderr: line => {
    const match = /\bpts_time:([\d.eE+-]+)/.exec(line);
    if (!match) return;
    const time = Number(match[1]);
    if (Number.isFinite(time) && time - (cuts.at(-1) ?? 0) >= minimum - 0.000001 && info.duration - time >= minimum - 0.000001) cuts.push(rounded(time));
  } });
  return cuts;
}

/** 240 RMS amplitude bins, in native 0..1 amplitude; an audio-less file has no bins. */
export async function waveform(path: string, options: MediaOptions): Promise<number[]> {
  const info = await probe(path, options);
  if (!info.hasAudio || info.duration <= 0) return [];
  const bins = 240;
  const rate = 8000;
  const squares = new Float64Array(bins);
  const counts = new Float64Array(bins);
  let sample = 0;
  let remainder: Buffer = Buffer.alloc(0);
  await run(options.ffmpegPath, [
    '-hide_banner', '-nostdin', '-nostats', '-v', 'error', '-i', resolve(path), '-map', '0:a:0',
    '-vn', '-ac', '1', '-ar', String(rate), '-acodec', 'pcm_s16le', '-f', 's16le', '-',
  ], { signal: options.signal, captureStdout: false, onStdout: chunk => {
    const data = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
    const length = data.length - data.length % 2;
    for (let i = 0; i < length; i += 2) {
      const bin = Math.min(bins - 1, Math.floor(sample++ / (info.duration * rate) * bins));
      const amplitude = data.readInt16LE(i) / 32768;
      squares[bin] += amplitude * amplitude;
      counts[bin]++;
    }
    remainder = data.subarray(length);
  } });
  return Array.from(squares, (value, index) => rounded(counts[index] ? Math.min(1, Math.sqrt(value / counts[index])) : 0));
}

export async function assemble(clips: MediaClip[], outPath: string, options: MediaOptions & { width?: number; height?: number; fps?: number; audio?: 'original' | 'none' }): Promise<void> {
  if (!Array.isArray(clips) || !clips.length) throw new Error('组装至少需要一个视频片段');
  for (const clip of clips) {
    finite(clip.in, '片段入点'); finite(clip.out, '片段出点');
    if (clip.out <= clip.in) throw new Error('片段出点必须晚于入点');
    if (clip.audioIn !== undefined) finite(clip.audioIn, '音频入点');
  }
  const metadata = new Map<string, MediaInfo>();
  // Limit concurrent probes for large timelines rather than launching a process per clip.
  const paths = [...new Set(clips.flatMap(clip => [clip.path, ...(clip.audioPath ? [clip.audioPath] : [])]))];
  for (let i = 0; i < paths.length; i += 4) {
    const batch = await Promise.all(paths.slice(i, i + 4).map(async path => [path, await probe(path, options)] as const));
    for (const [path, info] of batch) metadata.set(path, info);
  }
  const first = metadata.get(clips[0].path)!;
  const dimension = (value: number, name: string) => {
    finite(value, name, 2, 8192);
    if (!Number.isInteger(value) || value % 2) throw new Error(`${name}必须为偶数整数`);
    return value;
  };
  const width = dimension(options.width ?? Math.max(2, Math.ceil(first.width / 2) * 2), '输出宽度');
  const height = dimension(options.height ?? Math.max(2, Math.ceil(first.height / 2) * 2), '输出高度');
  const fps = finite(options.fps ?? (first.fps || 25), '输出帧率', 1, 240);
  const includeAudio = options.audio !== 'none';
  const args = ['-hide_banner', '-nostdin', '-nostats', '-v', 'error', '-n'];
  const filters: string[] = [];
  const concat: string[] = [];
  let inputIndex = 0;
  let duration = 0;
  for (const [index, clip] of clips.entries()) {
    const info = metadata.get(clip.path)!;
    if (info.kind !== 'video') throw new Error(`片段 ${index + 1} 不是视频`);
    if (clip.out > info.duration + 0.001) throw new Error(`片段 ${index + 1} 的出点超出素材时长`);
    const length = clip.out - clip.in;
    duration += length;
    const videoIndex = inputIndex++;
    args.push('-i', resolve(clip.path));
    filters.push(`[${videoIndex}:v:0]trim=start=${seconds(clip.in)}:end=${seconds(clip.out)},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${index}]`);
    concat.push(`[v${index}]`);
    if (includeAudio) {
      let audioIndex = videoIndex;
      let audioInfo = info;
      if (clip.audioPath) {
        audioIndex = inputIndex++;
        audioInfo = metadata.get(clip.audioPath)!;
        args.push('-i', resolve(clip.audioPath));
      }
      const audioStart = clip.audioIn ?? clip.in;
      const audio = audioInfo.hasAudio
        ? `[${audioIndex}:a:0]atrim=start=${seconds(audioStart)}:duration=${seconds(length)},asetpts=PTS-STARTPTS,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${seconds(length)},atrim=duration=${seconds(length)}`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${seconds(length)}`;
      filters.push(`${audio}[a${index}]`);
      concat.push(`[a${index}]`);
    }
  }
  filters.push(`${concat.join('')}concat=n=${clips.length}:v=1:a=${includeAudio ? 1 : 0}[video]${includeAudio ? '[audio]' : ''}`);
  args.push('-filter_complex', filters.join(';'), '-map', '[video]');
  if (includeAudio) args.push('-map', '[audio]', '-c:a', 'aac', '-b:a', '192k');
  else args.push('-an');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-t', seconds(duration), '-movflags', '+faststart', '-f', 'mp4');
  options.onProgress?.(`正在组装 ${clips.length} 个片段（${rounded(duration)} 秒）`);
  await outputFile(outPath, options, temporary => run(options.ffmpegPath, [...args, temporary], options).then(() => undefined));
}

/** Timing/cut evidence only: semantic shot identity cannot be proved from durations. */
export async function suggestAlignment(sourceClips: { shotId: string; duration: number }[], generatedPath: string, options: MediaOptions): Promise<Alignment[]> {
  if (!sourceClips.length) throw new Error('对齐至少需要一个源镜头');
  for (const clip of sourceClips) {
    if (!clip.shotId) throw new Error('对齐镜头缺少 ID');
    finite(clip.duration, '源镜头时长', 0.001);
  }
  const info = await probe(generatedPath, options);
  if (info.kind !== 'video' || info.duration <= 0) throw new Error('对齐目标必须是有时长的视频');
  const total = sourceClips.reduce((sum, clip) => sum + clip.duration, 0);
  const cuts = sourceClips.length > 1 ? await sceneDetect(generatedPath, { ...options, threshold: 0.25, minDuration: 0.1 }) : [];
  const sourceBoundaries = [0];
  for (const clip of sourceClips) sourceBoundaries.push(sourceBoundaries.at(-1)! + clip.duration);
  const generatedBoundaries = sourceBoundaries.map(time => time / total * info.duration);
  const scores = generatedBoundaries.map(() => 0.2);
  const used = new Set<number>();
  for (let index = 1; index < generatedBoundaries.length - 1; index++) {
    const expected = generatedBoundaries[index];
    const leftSpan = sourceClips[index - 1].duration / total * info.duration;
    const rightSpan = sourceClips[index].duration / total * info.duration;
    const tolerance = Math.min(0.75, Math.min(leftSpan, rightSpan) * 0.35);
    const choices = cuts.filter(cut => !used.has(cut) && Math.abs(cut - expected) <= tolerance && cut > generatedBoundaries[index - 1] && cut < generatedBoundaries[index + 1]);
    choices.sort((a, b) => Math.abs(a - expected) - Math.abs(b - expected));
    if (choices.length && (choices.length === 1 || Math.abs(choices[1] - expected) - Math.abs(choices[0] - expected) > 0.1)) {
      const cut = choices[0];
      generatedBoundaries[index] = cut;
      scores[index] = 0.72 - Math.abs(cut - expected) / tolerance * 0.22;
      used.add(cut);
    }
  }
  return sourceClips.map((clip, index) => {
    const sourceIn = rounded(sourceBoundaries[index]);
    const sourceOut = rounded(sourceBoundaries[index + 1]);
    const generatedIn = rounded(generatedBoundaries[index]);
    const generatedOut = rounded(generatedBoundaries[index + 1]);
    const evidence = [index > 0 ? scores[index] : undefined, index < sourceClips.length - 1 ? scores[index + 1] : undefined].filter((value): value is number => value !== undefined);
    return {
      shotId: clip.shotId, sourceIn, sourceOut, generatedIn, generatedOut,
      confidence: rounded(evidence.length ? Math.min(...evidence) : 0.35), confirmed: false,
      anchors: [{ source: sourceIn, generated: generatedIn }, { source: sourceOut, generated: generatedOut }],
    };
  });
}
