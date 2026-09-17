# Module contract
All times seconds, half-open ranges. IDs server generated. Source imports read-only; outputs unique paths under dataDir. Shared types in src/shared/types.ts owned by root.

Renderer only HTTP: GET /api/state -> WorkspaceState (apiKey redacted; apiKeySet extra). POST /api/command {type,...} returns {state,result?}. GET /media/:assetId (original/proxy), GET /media/:assetId?thumbnail=1, GET /api/frame?assetId=&time= (jpeg). POST /api/import multipart files plus episodeId, role, shotId(optional manual image candidate), segmentId(optional manual video take). Errors {error}. Poll state 1500ms while jobs active. No mocks in production.
Commands:
- episode.create {name}; episode.update {id,patch:{name,script,brief,look,fullPrompt,skipImages}}
- asset.update {id,patch:{name,role,remoteUrl}}; asset.remove {id}
- shots.detect {assetId,threshold?:number,minDuration?:number} job; shot.create {episodeId,assetId,in,out}; shot.update {id,patch}; shot.delete {id}
- ai.analyze {episodeId,shotId?} job; ai.episodePrompt {episodeId} job; ai.imagePrompt {shotId} job; ai.image {shotId,prompt?,takeId?} job; ai.revise {takeId,feedback} job; ai.segmentPrompt {segmentId} job
- image.capture {shotId,time} -> asset; take.approve {id,scope?:'shot'|'look'}; take.reject {id}; take.feedback {id,feedback}
- segment.create {episodeId,shotIds:string[],name?}; segment.update {id,patch:{name,clips,prompt,mode,selectedTakeId}}; segment.prepare {id} job; segment.generate {id} job; segment.delete {id}
- take.align {id,alignments}; take.autoAlign {id} job
- review.create {takeId,time,text}; review.delete {id}
- settings.update {patch}; settings.check {} -> capabilities result; codex.check {} job; job.cancel {id}; job.retry {id}; job.resume {id,remoteId?}
- export.video {episodeId,segmentIds?:string[],audio:'original'|'generated'} job (selected takes or original segment), export.project {episodeId} job. job resultId asset for exports; prompt download client blob allowed.

Media module src/server/media.ts exports async:
probe(path, options):MediaInfo
createProxy(path,outPath,options):void
extractFrame(path,time,outPath,options):void
sceneDetect(path,options & {threshold?:number,minDuration?:number}):number[] (cut points internal only)
waveform(path,options):number[]
assemble(clips:MediaClip[],outPath,options & {width?:number,height?:number,fps?:number,audio?:'original'|'none'}):void
suggestAlignment(sourceClips:{shotId:string,duration:number}[],generatedPath,options):Alignment[]
Tests and helper files media.* owned media agent.

AI module src/server/ai.ts exports async:
checkCodex(settings:Settings):{version:string,authenticated:boolean,imageAvailable:boolean,detail:string}
runCodex(settings,request:CodexRequest):{text:string,json?:any,images:string[],threadId?:string}
compileEpisode(episode,shots,assets):string (deterministic fallback usable editable prompts)
compileSegment(episode,segment,shots,assets,takes):string
submitVideo(settings,request:VideoRequest,onUploaded?:(input:VideoInput,url:string)=>void):{id:string,request:unknown}
getVideoTask(settings,id):{status:'queued'|'running'|'succeeded'|'failed'|'cancelled',url?:string,error?:string,raw?:unknown}
downloadVideo(url,outPath,signal?):void
Optional exports allowed. Agent owns ai.ts, providers/*, tests/ai*.test.ts, docs/AI-INTEGRATION.md; actual small Codex smoke authorized, no video key.

Root owns store.ts service.ts index.ts Electron config scripts integration tests.
Renderer owns src/renderer/*, index.html, vite.config.ts, may add CSS/components. React without component deps. Professional dark Chinese video editing UI; all routes above implemented root. No hardcoded production data.

Implemented additions: Take.sourceClips/sourceAssetId freeze source provenance; Shot.sourceFrameId/sourceFrameTime retain selected edit base. take.trim {id,in,out} persists Take.exportIn/exportOut for final export. GET /api/session establishes local browser/dev session. Job.progress uses 0..1. ai.revise only compiles a revised prompt; generation remains an explicit action. Look approval applies to the same scene. Frame/media routes support authorized files inside the hidden data directory.
