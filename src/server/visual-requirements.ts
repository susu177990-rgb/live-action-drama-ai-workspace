import { FUSION_RULES } from './fusion-rules.js';
import type { WorkspaceState } from '../shared/types.js';
export function visualRequirements(state: WorkspaceState, episodeId: string, shotIds?: string[]) {
 const ep=state.episodes.find(e=>e.id===episodeId);if(!ep)return '';
 const project=state.projects?.find(p=>p.id===ep.projectId);
 const shots=state.shots.filter(s=>s.episodeId===ep.id&&(!shotIds||shotIds.includes(s.id)));
 const sceneNames=new Set(shots.map(s=>s.scene));
 const scenes=Object.entries(ep.sceneLooks||{}).filter(([scene])=>!shotIds||sceneNames.has(scene));
 return [FUSION_RULES, '要求按作用范围执行：大项目统一风格与质感；本集及场景分别决定影调、光影，不把某一场景的照明套用到其他场景。镜头独立要求只影响该镜头。以下当前用户要求优先于旧提示词，未填写的局部光影依据本集实际场地和资产规划。',`大项目统一风格与质感：${project?.visualStyle||'未设置'}`,`本集影调与光影：${ep.look||'按实际场景规划'}`,...scenes.map(([scene,look])=>`场景「${scene}」影调与光影：${look}`),...shots.filter(s=>s.requirements?.trim()).map(s=>`镜头「${s.name}」[${s.id}] 独立要求：${s.requirements}`)].join('\n');
}
export function applyVisualRequirements(prompt:string,context:string){
 if(!context)return prompt;
 return `${prompt.replace(/\n?【当前分层画面要求】[\s\S]*?【分层要求结束】\n?/g,'').trim()}\n\n【当前分层画面要求】\n${context}\n【分层要求结束】`;
}
