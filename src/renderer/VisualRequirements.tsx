import { useState } from 'react';
import type { Episode, Shot } from '../shared/types';
import { Field, Modal, safeAction, type Command, type State } from './common';
export function EpisodeVisualRequirements({state,episode,command,close}:{state:State;episode:Episode;command:Command;close:()=>void}){
 const project=state.projects.find(p=>p.id===episode.projectId);
 const [scene,setScene]=useState('');
 const scenes=[...new Set([...Object.keys(episode.sceneLooks||{}),...state.shots.filter(s=>s.episodeId===episode.id).map(s=>s.scene).filter(Boolean),...(scene.trim()?[scene.trim()]:[])])];
 return <Modal title="本集与场景 · 影调和光影" close={close} wide><div className="modal-body"><div className="visual-inherited"><h3>继承大项目的风格与质感</h3><p>{project?.visualStyle||'大项目尚未设置统一风格与质感。'}</p></div><Field label="本集影调与光影基准" value={episode.look} multiline onSave={look=>command('episode.update',{id:episode.id,patch:{look}})}/><p className="hint">以下场景可分别设定色温、明暗、主光方向及环境氛围，按最终场地调整；未填写则沿用本集基准并结合场景素材规划。</p>{scenes.map(name=><section className="scene-look-editor" key={name}><Field label={`场景「${name}」影调与光影`} value={episode.sceneLooks?.[name]||''} multiline onSave={look=>command('episode.sceneLook',{id:episode.id,scene:name,look})}/></section>)}<label className="field"><span>补充场景名称</span><input value={scene} onChange={e=>setScene(e.target.value)} placeholder="与镜头中的场景名称一致"/></label>{episode.brief&&<details><summary>历史本集制作备注</summary><Field label="历史制作备注" value={episode.brief} multiline onSave={brief=>command('episode.update',{id:episode.id,patch:{brief}})}/></details>}</div></Modal>;
}
export function ShotRequirements({state,shot,command,sceneControls=false}:{state:State;shot:Shot;command:Command;sceneControls?:boolean}){
 const ep=state.episodes.find(e=>e.id===shot.episodeId);
 return <section className="shot-requirements"><Field label={`${shot.name} · 独立画面要求`} value={shot.requirements||''} multiline rows={3} onSave={requirements=>command('shot.update',{id:shot.id,patch:{requirements}})}/>{sceneControls&&ep&&<details><summary>本镜场景与光影 · {shot.scene||'尚未识别场景'}</summary><Field label="本镜场景名称" value={shot.scene} onSave={scene=>command('shot.update',{id:shot.id,patch:{scene}})}/>{shot.scene&&<Field label={`场景「${shot.scene}」影调与光影`} value={ep.sceneLooks?.[shot.scene]||''} multiline onSave={look=>command('episode.sceneLook',{id:ep.id,scene:shot.scene,look})}/>}<p className="hint">场景光影用于本集同场景镜头；独立画面要求仅作用于当前镜头。</p></details>}</section>;
}
