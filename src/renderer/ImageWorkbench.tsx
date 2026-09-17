import { useEffect, useRef, useState } from 'react';
import type { Shot } from '../shared/types';
import type { PreparedEpisode, Upload } from './App';
import { Empty, Field, media, safeAction, type Command, type State } from './common';
import { ShotRequirements } from './VisualRequirements';

type PlannedShot = Shot & { issues?: string[]; automated?: boolean };
const firstFrame = (shot: Shot) => shot.sourceFrameId ? media(shot.sourceFrameId) : `/api/frame?assetId=${encodeURIComponent(shot.assetId)}&time=${shot.in}`;

export function ImageWorkspace({ state, episode, command, upload, importing, next, addMaterials }: { state: State; episode: PreparedEpisode; command: Command; upload: Upload; importing: boolean; next: () => Promise<void>; addMaterials: () => void }) {
  const shots = state.shots.filter(s => s.episodeId === episode.id) as PlannedShot[];
  const [selected, setSelected] = useState<string[]>([]), [filter, setFilter] = useState('all'), [cursor, setCursor] = useState(0), [takeId, setTakeId] = useState(''), [detailsOpen, setDetailsOpen] = useState(false), [batching, setBatching] = useState(false), [entering, setEntering] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const approval = (shot: Shot) => state.takes.find(t => t.id === shot.approvedImageId && t.status === 'approved' && t.sourceRevision === shot.revision);
  const activeJob = (id: string) => state.jobs.find(j => j.targetId === id && ['queued', 'running', 'waiting'].includes(j.status) && ['ai.image', 'ai.imagePrompt', 'ai.revise'].includes(j.type));
  const active = (id: string) => !!activeJob(id);
  const needsImagePreparation = (shot: PlannedShot) => shot.analysisSkipped === true || (shot.analysisSkipped === undefined && shot.automated !== true && (episode.analysisSkipped === true || shot.facts.includes('已跳过 AI 分析') || shot.imagePrompt.includes('当前镜头已跳过 AI 分析')));
  const canGenerate = (shot: PlannedShot) => needsImagePreparation(shot) || (shot.confirmed && !!shot.imagePrompt.trim());
  const filtered = shots.filter(s => filter === 'all' || (filter === 'issues' ? !!s.issues?.length : filter === 'approved' ? !!approval(s) : !(approval(s) || s.skipImage || episode.skipImages)));
  const current = filtered[Math.min(cursor, Math.max(0, filtered.length - 1))];
  const currentTakes = current ? state.takes.filter(t => t.kind === 'image' && t.shotId === current.id).sort((a, b) => b.version - a.version) : [];
  const shownTake = current ? currentTakes.find(t => t.id === takeId) || approval(current) || currentTakes[0] : undefined;
  const shownAsset = shownTake && state.assets.find(a => a.id === shownTake.assetId);
  const referenceAssets = current ? state.assets.filter(a => a.episodeId === current.episodeId && a.kind === 'image' && !['image-candidate', 'source-frame', 'original-frame'].includes(a.role)) : [];
  useEffect(() => setCursor(0), [filter]);
  useEffect(() => { if (cursor >= filtered.length) setCursor(Math.max(0, filtered.length - 1)); }, [cursor, filtered.length]);
  useEffect(() => { setTakeId(''); setDetailsOpen(false); }, [current?.id]);

  async function batch() {
    setBatching(true);
    try {
      for (const id of selected) {
        const shot = shots.find(s => s.id === id);
        if (shot && canGenerate(shot) && !active(id)) await command('ai.image', { shotId: id });
      }
      setSelected([]);
    } finally { setBatching(false); }
  }
  async function enter() { setEntering(true); try { await next(); } finally { setEntering(false); } }
  if (!shots.length) return <main className="image-workspace"><div className="gallery-empty"><Empty title="尚无镜头">请先添加原视频并完成切镜。</Empty><button className="primary" onClick={addMaterials}>添加素材</button></div></main>;

  return <main className="image-workspace image-workbench">
    <div className="page-title image-workbench-title"><div><span className="eyebrow">先确定画面，再制作视频</span><h1>分镜图工作台</h1></div><button className="primary large" disabled={entering} onClick={() => safeAction(enter)}>{entering ? '正在进入…' : '进入视频工作台 →'}</button></div>
    <div className="gallery-toolbar"><div className="segmented"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部镜头</button><button className={filter === 'pending' ? 'active' : ''} onClick={() => setFilter('pending')}>待选定</button><button className={filter === 'approved' ? 'active' : ''} onClick={() => setFilter('approved')}>已选定</button>{shots.some(s => s.issues?.length) && <button className={filter === 'issues' ? 'active' : ''} onClick={() => setFilter('issues')}>需要补充 · {shots.filter(s => s.issues?.length).length}</button>}</div></div>
    {current ? <div className="storyboard-layout">
      <section className="storyboard-compare">
        <header><div><strong>{current.name}</strong><span>{(current.out - current.in).toFixed(1)}s</span></div><div className="row"><label className="check compact"><input type="checkbox" checked={selected.includes(current.id)} onChange={e => setSelected(ids => e.target.checked ? [...new Set([...ids, current.id])] : ids.filter(id => id !== current.id))} />加入批量</label><span className={`tag ${approval(current) ? 'success' : current.issues?.length ? 'warning' : ''}`}>{activeJob(current.id)?.status === 'queued' ? '排队中' : active(current.id) ? '正在生成' : approval(current) ? '已选定' : current.issues?.length ? '需要补充' : currentTakes.length ? `${currentTakes.length} 个候选` : '待生成'}</span></div></header>
        <div className="storyboard-screens"><div className="storyboard-screen"><span>实拍首帧</span><img src={firstFrame(current)} alt={`${current.name} 实拍首帧`} /></div><div className={`storyboard-screen generated-screen ${detailsOpen ? 'show-details' : ''}`}><span>{detailsOpen ? '本镜详情' : approval(current) ? '已选定分镜图' : shownTake ? `候选 V${shownTake.version}` : '生成画面'}</span><button className="screen-detail-toggle" onClick={() => setDetailsOpen(value => !value)}>{detailsOpen ? '返回画面' : '查看详情'}</button>{detailsOpen ? <div className="screen-details"><ShotRequirements state={state} shot={current} command={command} sceneControls/><section className="storyboard-reference-section"><div className="row spread"><h3>关联素材</h3><span className="muted">已选 {current.referenceIds.length}</span></div><div className="reference-list storyboard-reference-list">{referenceAssets.map(a => <label className={`reference-item ${current.referenceIds.includes(a.id) ? 'selected' : ''}`} key={a.id}><input type="checkbox" checked={current.referenceIds.includes(a.id)} onChange={e => safeAction(() => command('shot.update', { id: current.id, patch: { referenceIds: e.target.checked ? [...current.referenceIds, a.id] : current.referenceIds.filter(id => id !== a.id) } }))} /><img src={media(a.id)} alt="" /><span><strong>{a.name}</strong><small>{a.role}</small></span></label>)}</div></section><Field label="静态提示词" value={current.imagePrompt} onSave={imagePrompt => command('shot.update', { id: current.id, patch: { imagePrompt } })} multiline rows={6} /><div className="row wrap"><button disabled={active(current.id)} onClick={() => safeAction(() => command('ai.imagePrompt', { shotId: current.id }))}>Codex 重新编写提示词</button>{!current.confirmed && !needsImagePreparation(current) && <button onClick={() => safeAction(() => command('shot.update', { id: current.id, patch: { confirmed: true, issues: [] } }))}>已核对本镜要求</button>}</div></div> : shownAsset ? <img src={media(shownAsset.id)} alt={`${current.name} 当前候选`} /> : <Empty title="暂无生成画面">可直接生成或上传分镜图</Empty>}{!detailsOpen && !!currentTakes.length && <div className="screen-candidates">{currentTakes.map(t => <button className={shownTake?.id === t.id ? 'selected' : ''} key={t.id} onClick={() => setTakeId(t.id)}>V{t.version}</button>)}</div>}<div className="screen-generate-actions">{shownTake && <button className={current.approvedImageId === shownTake.id ? 'secondary' : ''} onClick={() => safeAction(() => command('take.approve', { id: shownTake.id, scope: 'shot' }))}>{current.approvedImageId === shownTake.id ? '✓ 已选定' : '选定此图'}</button>}<button disabled={importing} onClick={() => input.current?.click()}>{importing ? '上传中…' : '上传分镜图'}</button>{needsImagePreparation(current) && <button disabled={active(current.id) || !current.imagePrompt.trim()} onClick={() => safeAction(() => command('ai.image', { shotId: current.id, direct: true }))}>直接生成</button>}<button className="primary" disabled={active(current.id) || !canGenerate(current)} onClick={() => safeAction(() => command('ai.image', { shotId: current.id }))}>{active(current.id) ? '正在生成…' : needsImagePreparation(current) ? '自动匹配并生成' : currentTakes.length ? '生成新候选' : '生成分镜图'}</button><input ref={input} aria-label="上传分镜图" type="file" accept="image/*" multiple hidden onChange={e => { const files = Array.from(e.target.files || []); if (files.length) safeAction(() => upload(files, 'image-candidate', { shotId: current.id })); e.target.value = ''; }} /></div></div></div>
      </section>
      <div className="storyboard-sidebar"><div className="storyboard-selection-actions"><button onClick={() => setSelected(selected.length ? [] : filtered.map(s => s.id))}>{selected.length ? '取消选择' : '选择当前列表'}</button>{selected.length > 0 && <button className="primary" disabled={batching || !shots.some(s => selected.includes(s.id) && canGenerate(s) && !active(s.id))} onClick={() => safeAction(batch)}>{batching ? '正在提交…' : `生成所选 ${selected.length} 镜头`}</button>}</div><aside className="storyboard-shot-list"><header><strong>镜头列表</strong><span>{filtered.length}</span></header><div>{filtered.map((shot, index) => { const approved = !!approval(shot), job = activeJob(shot.id), hasCandidates = state.takes.some(t => t.kind === 'image' && t.shotId === shot.id); return <div className={`storyboard-shot-row ${shot.id === current.id ? 'active' : ''} ${selected.includes(shot.id) ? 'checked' : ''}`} key={shot.id}><label className="shot-list-check"><input aria-label={`选择 ${shot.name}`} type="checkbox" checked={selected.includes(shot.id)} onChange={e => setSelected(ids => e.target.checked ? [...new Set([...ids, shot.id])] : ids.filter(id => id !== shot.id))} /></label><button onClick={() => setCursor(index)}><img loading="lazy" src={firstFrame(shot)} alt="" /><span><strong>{shot.name}</strong><small>{(shot.out - shot.in).toFixed(1)}s · {job?.status === 'queued' ? '排队中' : job ? '正在生成' : approved ? '已选定' : shot.skipImage ? '已跳过' : hasCandidates ? '待选定' : '待生成'}</small></span><b>{String(shots.indexOf(shot) + 1).padStart(2, '0')}</b></button></div>; })}</div></aside></div>
    </div> : <div className="gallery-empty"><Empty title="当前筛选没有镜头">请选择其他筛选状态。</Empty></div>}
  </main>;
}
