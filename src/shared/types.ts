export type ID = string;
export interface Project {
  /** Legacy storage only; production baseline is now built in. */
  visualBrief?: string;
  visualStyle?: string;
  id: ID; name: string; script: string; summary: string; createdAt: string;
}
export interface Episode {
  analysisSkipped?: boolean;
  sceneLooks?: Record<string, string>;
  projectId?: ID;
  workflowVersion?: number;
  id: ID;
  name: string;
  script: string;
  brief: string;
  look: string;
  fullPrompt: string;
  skipImages: boolean;
  createdAt: string;
  revision: number;
  preparation?: {
    status: "pending" | "running" | "paused" | "ready" | "failed";
    stage: string;
    message: string;
    jobId?: ID;
    error?: string;
    inputSignature?: string;
  };
  materialAnalysis?: string;
}
export type AssetKind = "video" | "image" | "audio" | "document";
export interface Asset {
  analysis?: string;
  id: ID;
  episodeId: ID;
  name: string;
  kind: AssetKind;
  role: string;
  path: string;
  proxyPath?: string;
  thumbnailPath?: string;
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio?: boolean;
  waveform?: number[];
  text?: string;
  remoteUrl?: string;
  createdAt: string;
}
export interface Shot {
  analysisSkipped?: boolean;
  requirements?: string;
  issues?: string[];
  automated?: boolean;
  sourceFrameId?: ID;
  sourceFrameTime?: number;
  id: ID;
  episodeId: ID;
  assetId: ID;
  name: string;
  in: number;
  out: number;
  scene: string;
  facts: string;
  plan: string;
  imagePrompt: string;
  videoPrompt: string;
  referenceIds: ID[];
  approvedImageId?: ID;
  skipImage: boolean;
  confirmed: boolean;
  revision: number;
}
export interface Clip {
  id: ID;
  shotId: ID;
  assetId: ID;
  in: number;
  out: number;
}
export interface Segment {
  id: ID;
  episodeId: ID;
  name: string;
  clips: Clip[];
  prompt: string;
  mode: "edit" | "reference";
  outputDuration?: number;
  outputRatio?: "source" | "adaptive" | "16:9" | "9:16" | "1:1" | "4:3" | "3:4" | "21:9";
  outputResolution?: "source" | "480p" | "720p" | "1080p";
  duration: number;
  sourceAssetId?: ID;
  selectedTakeId?: ID;
  revision: number;
}
export interface Anchor {
  source: number;
  generated: number;
}
export interface Alignment {
  shotId: ID;
  sourceIn: number;
  sourceOut: number;
  generatedIn: number;
  generatedOut: number;
  confidence: number;
  confirmed: boolean;
  anchors: Anchor[];
}
export interface Take {
  exportIn?: number;
  exportOut?: number;
  sourceClips?: Clip[];
  sourceAssetId?: ID;
  id: ID;
  episodeId: ID;
  kind: "image" | "video";
  shotId?: ID;
  segmentId?: ID;
  assetId: ID;
  prompt: string;
  version: number;
  status: "candidate" | "approved" | "rejected";
  feedback: string;
  sourceRevision: number;
  createdAt: string;
  alignments: Alignment[];
}
export interface Review {
  id: ID;
  episodeId: ID;
  takeId: ID;
  time: number;
  text: string;
  createdAt: string;
}
export interface Job {
  id: ID;
  episodeId: ID;
  type: string;
  targetId: string;
  status:
    | "queued"
    | "running"
    | "waiting"
    | "succeeded"
    | "failed"
    | "paused"
    | "cancelled"
    | "uncertain";
  progress: number;
  message: string;
  error?: string;
  remoteId?: string;
  resultId?: ID;
  createdAt: string;
  updatedAt: string;
  payload: Record<string, unknown>;
}
export interface Settings {
  storageDir?: string;
  exportDir?: string;
  llmProvider: 'codex' | 'custom';
  imageProvider: 'codex' | 'custom';
  llmApiBaseUrl: string;
  llmApiKey: string;
  llmApiModel: string;
  imageApiBaseUrl: string;
  imageApiKey: string;
  imageApiModel: string;
  codexPath: string;
  codexModel: string;
  ffmpegPath: string;
  ffprobePath: string;
  apiBaseUrl: string;
  apiKey: string;
  videoModel: string;
  uploadBaseUrl: string;
  videoDurationLimit: number;
  resolution: string;
  ratio: string;
  generateAudio: boolean;
  dataDir: string;
  imageCapability: string;
}
export interface WorkspaceState {
  projects: Project[];
  episodes: Episode[];
  assets: Asset[];
  shots: Shot[];
  segments: Segment[];
  takes: Take[];
  reviews: Review[];
  jobs: Job[];
  settings: Settings;
  revision: number;
}
export interface MediaInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  kind: AssetKind;
}
export interface MediaOptions {
  ffmpegPath: string;
  ffprobePath: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}
export interface MediaClip {
  path: string;
  in: number;
  out: number;
  audioPath?: string;
  audioIn?: number;
}
export interface CodexRequest {
  prompt: string;
  images?: string[];
  cwd: string;
  outputPath: string;
  schema?: Record<string, unknown>;
  image?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: any) => void;
}
export interface VideoInput {
  path?: string;
  url?: string;
  kind: "image" | "video" | "audio";
  role?: string;
  name?: string;
}
export interface VideoRequest {
  prompt: string;
  inputs: VideoInput[];
  duration: number;
  mode: "edit" | "reference";
  ratio?: string;
  resolution?: string;
}
