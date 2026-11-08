import {assetsMarkup,mountAssets,shotAssetsMarkup} from './assets-ui.js';
import { normalizeVideoOptions, videoDurations, videoProfileLabels, videoResolutionLabel,videoSpecification } from './video-options.js';
import { showPromptPicker } from './prompts.js';
import { mountProductionUI, updateProductionUI, productionClick, productionInput,qualityControlsMarkup } from './production-ui.js';
import { normalizeProduction } from './director-options.js';
import { upscaleMarkup,upscaleClick } from './upscale.js';
import { openFrameImport } from './frame-import.js';
const $ = selector => document.querySelector(selector);
const h = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const names = { waiting: '待执行', dispatched: '处理中', submitting: '提交中', queued: '排队中', running: '生成中', recovering: '恢复连接中', success: '已完成', failed: '失败', cancelled: '已取消' };
const categories = { character: '角色', scene: '场景', prop: '道具', style:'风格' };
const defaultImage = '';
const defaultVideo = '';
const shotCollapseKey = id => 'aigc-shot-collapsed-' + currentId + '-' + id;
let visible = false;
let projects = [];
let assets = [];
let snapshot;
let draft;
let busy = false;
let signatures = new Map();
const frameChoices = new Map();
let currentId = localStorage.getItem('aigc-project') || '';
let audio=[],dirty=false,revision=0,saving,saveTimer,catalogRenderPending=false;
window.addEventListener('beforeunload',event=>{if(dirty||saving){event.preventDefault();event.returnValue='';}});
function saveStatus(message){const node=$('#autosave-status');if(node)node.textContent=message;}
function changed(){dirty=true;revision++;saveStatus('有未保存修改');scheduleSave();}
function scheduleSave(){clearTimeout(saveTimer);saveTimer=setTimeout(async()=>{if(busy||saving||working()){scheduleSave();return;}try{await saveProject();}catch(error){saveStatus('未保存：'+error.message);}},1200);}
async function api(path, body, method = 'POST') {
  const response = await fetch(path, body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || '请求失败。'),{status:response.status});
  return data;
}
function notice(message, error = false) {
  $('#notice').hidden = !message; $('#notice').textContent = message;
  $('#notice').className = 'notice ' + (error ? 'error' : 'success');
}
function working() { return snapshot?.queue.some(item => ['waiting', 'dispatched'].includes(item.status))||snapshot?.jobs.some(j=>j.enhancement&&['submitting','running'].includes(j.status)); }
function job(id) { return snapshot?.jobs.find(item => item.id === id); }
function externalFrame(item) { return item?.source === 'external' || !!item?.externalFrame; }
function approvedExternal(shot, item) { return externalFrame(item) && item?.status === 'success' && shot.confirmedFrameJobId === item.id && shot.frameApproval?.jobId === item.id && !!item.outputs?.[0]?.sha256 && shot.frameApproval.sha256 === item.outputs[0].sha256; }
function matchesCharacter(shot, item) { if(externalFrame(item))return item?.status==='success'&&!!item.outputs?.[0]?.sha256;const plan=snapshot?.plans?.find(p=>p.shotId===shot.id);const signature = snapshot?.characterSignatures?.[shot.id]; return (!signature || item?.characterSignature === signature)&&(!plan?.frameSignature||item?.frameSignature===plan.frameSignature); }
function videoReady(shot) { const item = job(shot.videoJobId),plan=snapshot?.plans?.find(p=>p.shotId===shot.id),frame=job(shot.confirmedFrameJobId);return item?.status === 'success' && item.frameJobId === shot.confirmedFrameJobId && (externalFrame(frame)?approvedExternal(shot,frame)&&item.externalFrameHash===shot.frameApproval.sha256:matchesCharacter(shot,item))&&(!plan?.videoSignature||item.videoSignature===plan.videoSignature); }
function showFrameImport(shotId, file) { const shot=draft?.shots.find(item=>item.id===shotId);if(!shot)return;void openFrameImport({project:draft,shot,api,save:saveProject,reload:load,notice,perform,isBusy:()=>busy||working(),file}); }
async function perform(action) {
  if (busy) return;
  busy = true;
  $('#projects-panel').classList.add('request-busy');
  try { await action(); }
  catch (error) { notice(error.message, true); }
  finally { busy = false; $('#projects-panel').classList.remove('request-busy'); }
}
export async function openProjects() {
  if (visible) return;
  visible = true;
  try {
    [projects, assets, audio] = await Promise.all([api('/api/projects'), api('/api/assets'),api('/api/audio')]);
    if (!projects.some(item => item.id === currentId)) currentId = projects[0]?.id || '';
    await load(true);
  } catch (error) { visible = false; notice(error.message, true); }
}
export function closeProjects() { visible = false; }
async function load(full) {
  if (currentId) {
    const requestedId = currentId;
    let loaded;
    try{loaded=await api('/api/projects/'+requestedId);}catch(error){if(error.status!==404)throw error;[projects,assets]=await Promise.all([api('/api/projects'),api('/api/assets')]);currentId='';snapshot=null;draft=null;dirty=false;clearTimeout(saveTimer);localStorage.removeItem('aigc-project');render();return;}
    if (requestedId !== currentId) return;
    const assetsChanged=JSON.stringify(assets)!==JSON.stringify(loaded.assets)||JSON.stringify(snapshot?.project?.catalog)!==JSON.stringify(loaded.project.catalog);
    snapshot = loaded;
    assets=loaded.assets||[];
    if(assetsChanged&&!full){catalogRenderPending=true;const valid=new Set(assets.map(a=>a.id));draft.catalog=structuredClone(loaded.project.catalog);draft.characters=structuredClone(loaded.project.characters||[]);const roles=new Set(draft.characters.map(r=>r.id));if(draft.production)draft.production.referenceIds=(draft.production.referenceIds||[]).filter(id=>valid.has(id));for(const shot of draft.shots){shot.referenceIds=(shot.referenceIds||[]).filter(id=>valid.has(id));if(!dirty&&!saving){const current=loaded.project.shots.find(s=>s.id===shot.id);if(current)shot.characterIds=structuredClone(current.characterIds);}else if(shot.characterIds)shot.characterIds=shot.characterIds.filter(id=>roles.has(id));}}
    if (full) { draft = structuredClone(snapshot.project); dirty=false; frameChoices.clear(); }
    localStorage.setItem('aigc-project', currentId);
  } else { snapshot = null; draft = null; assets=[]; }
  if (full||catalogRenderPending&&!dirty&&!saving) {catalogRenderPending=false;render();}
  renderResults();
}
function specsMarkup() {
  const video = normalizeVideoOptions(draft.video);
  const ref=draft.videoTemplate==='h3-reference';
  return [['frames', '默认每镜时长', ref?Object.fromEntries(Object.entries(videoDurations).filter(([n])=>Number(n)<=124)):videoDurations], ['profile','生成分辨率',ref?{draft:videoProfileLabels(video).draft}:videoProfileLabels(video)], ['aspect','画面比例',ref?{square:'方形',portrait:'竖版',landscape:'横版'}:{source:'跟随首帧',square:'方形',portrait:'竖版',landscape:'横版'}], ['sound','声音',{keep:'保留声音',mute:'静音'}]].map(([key,label,choices]) => `<label>${label}<select data-project-video="${key}">${Object.entries(choices).map(([id,name]) => `<option value="${id}" ${String(video[key]) === id ? 'selected' : ''}>${name}</option>`).join('')}</select></label>`).join('');
}
function videoChoices(){
 if(!draft)return;const v=normalizeVideoOptions(draft.video);
 for(const option of document.querySelectorAll('[data-project-video="profile"] option'))if(option.value==='native720')option.disabled=v.frames>124||v.aspect==='source'||draft.shots.some(s=>s.frames>124);
 for(const option of document.querySelectorAll('[data-project-video="frames"] option'))option.disabled=v.profile==='native720'&&Number(option.value)>124;
 for(const option of document.querySelectorAll('[data-shot-frames] option'))option.disabled=v.profile==='native720'&&Number(option.value)>124;
 for(const option of document.querySelectorAll('[data-project-video="aspect"] option'))if(option.value==='source')option.disabled=v.profile==='native720';
 $('#project-video-description').textContent=videoSpecification(v).description+'；保存后新任务采用此规格。原生720p档限3～5秒；长镜头请拆分或选择自适应档。高清精修与拼接导出不改变原始生成分辨率。';
}
function shotCharacters(shot) {
  const roles = draft.characters || [];
  if (!roles.length) return '';
  const ids = shot.characterIds ?? roles.map(role => role.id);
  return `<fieldset class="shot-characters"><legend>本镜头出场角色</legend>${roles.map(role => `<label><input type="checkbox" data-shot-character="${role.id}" ${ids.includes(role.id) ? 'checked' : ''}>${h(role.name)}</label>`).join('')}<p class="field-help">角色固定参考自动参与首帧生成；下方参考素材可补充场景或道具，合计最多 20 张。</p></fieldset>`;
}
function render() {
  signatures.clear();
  $('#projects-panel').innerHTML = `
    <div class="project-toolbar"><label>当前项目<select id="project-choice"><option value="">选择项目</option>${projects.map(item => `<option value="${item.id}" ${item.id === currentId ? 'selected' : ''}>${h(item.name)}</option>`).join('')}</select></label><button type="button" id="delete-project" class="project-button" ${draft ? '' : 'disabled'}>删除项目</button><label class="grow">新项目名称<input id="new-project-name" maxlength="80" placeholder="例如：三个镜头的日常故事"></label><button type="button" id="new-project" class="project-button">新建项目 ＋</button></div>
    ${assetsMarkup()}
    ${draft ? `<div class="project-meta"><label>项目名称<input id="project-name" maxlength="80" value="${h(draft.name)}"></label><label>视频模板<select id="project-video-template"><option value="h3-fast" ${draft.videoTemplate === 'h3-fast' ? 'selected' : ''}>H3 快速 8 步</option><option value="h3-base" ${draft.videoTemplate === 'h3-base' ? 'selected' : ''}>H3 基础 20 步</option></select></label><button type="button" id="save-project" class="project-button">保存项目</button></div><div class="video-option-grid project-video-specs">${specsMarkup()}</div><p id="project-video-description" class="field-help">${h(videoResolutionLabel(normalizeVideoOptions(draft.video)))}；高分辨率生成更慢。保存项目后，新生成的镜头采用此规格。</p><details class="project-script"><summary>剧本原文（手动编辑与存档）</summary><textarea id="project-script" rows="5" maxlength="30000" placeholder="在这里保存剧本，然后手动添加镜头。">${h(draft.script)}</textarea></details><div class="project-actions"><button type="button" id="add-shot" class="project-button">添加镜头 ＋</button><button type="button" id="batch-images" class="project-button">生成缺少的首帧</button><button type="button" id="batch-videos" class="project-button">生成待完成视频</button><button type="button" id="pause-batch" class="project-button">暂停队列</button><button type="button" id="export-project" class="project-button accent">按顺序拼接导出 ↗</button></div><p class="field-help">本机串行生成。先保存镜头 → 生成首帧 → 确认每张首帧 → 生成视频 → 拼接。时长、规格和声音按上方设置；固定比例会居中裁切首帧。已有视频需手动重做才会采用新设置。</p><div id="project-queue" aria-live="polite"></div><div id="shot-list">${draft.shots.map(shotMarkup).join('') || '<div class="empty-library">添加三个镜头，开始你的第一个项目。</div>'}</div><div id="project-exports"></div>` : '<div class="empty-library">新建一个项目，然后添加镜头、选择参考素材。</div>'}`;
  mountAssets({getDraft:()=>draft,assets,api,save:saveProject,reload:async()=>{await load(true);}});
  if (draft) {
    $('#project-name').oninput = event => { draft.name = event.target.value; };
    $('#project-video-template').onchange = event => { draft.videoTemplate = event.target.value; };
    $('#project-script').oninput = event => { draft.script = event.target.value; };
    mountProductionUI({getDraft:()=>draft,getSnapshot:()=>snapshot,assets,audio,api,save:saveProject,changed,isDirty:()=>dirty,perform,reload:async()=>{[assets,audio]=await Promise.all([api('/api/assets'),api('/api/audio')]);await load(true);},openRestored:async p=>{projects=await api('/api/projects');currentId=p.id;[assets,audio]=await Promise.all([api('/api/assets'),api('/api/audio')]);await load(true);}});
  }
}
function shotMarkup(shot, i) {
  const collapsed = localStorage.getItem(shotCollapseKey(shot.id)) === '1';
  return `<article class="shot-card" data-shot="${shot.id}"><div class="shot-heading"><span class="shot-number">${String(i + 1).padStart(2, '0')}</span><button type="button" class="shot-collapse" data-toggle-shot aria-controls="shot-content-${shot.id}" aria-expanded="${!collapsed}" aria-label="${collapsed ? '展开镜头内容' : '收起镜头内容'}" title="${collapsed ? '展开镜头内容' : '收起镜头内容'}">${collapsed ? '▸' : '▾'}</button><input aria-label="镜头名称" data-field="title" value="${h(shot.title)}" maxlength="80"><button type="button" data-move="-1" title="上移镜头" aria-label="上移镜头">↑</button><button type="button" data-move="1" title="下移镜头" aria-label="下移镜头">↓</button><button type="button" data-remove title="移除镜头" aria-label="移除镜头">×</button></div><div class="shot-content" id="shot-content-${shot.id}" ${collapsed ? 'hidden' : ''}><div class="shot-settings">${shotCharacters(shot)}${shotAssetsMarkup(shot,draft)}<label>首帧画面描述 <button type="button" class="shot-prompt-button" data-prompt-field="imagePrompt">选择提示词 ✦</button><textarea data-field="imagePrompt" rows="3" maxlength="6000">${h(shot.imagePrompt)}</textarea></label><label>动作、镜头与声音 <button type="button" class="shot-prompt-button" data-prompt-field="videoPrompt">选择提示词 ✦</button><textarea data-field="videoPrompt" rows="3" maxlength="6000">${h(shot.videoPrompt)}</textarea></label><div class="shot-reference"><details><summary>选择参考素材（0～20 张）</summary>${assets.map(asset => `<label><input type="checkbox" data-ref="${asset.id}" ${shot.referenceIds.includes(asset.id) ? 'checked' : ''}>${h(asset.name)} · ${categories[asset.category]}</label>`).join('') || '<p class="field-help">先在素材库保存参考图。</p>'}</details></div><p class="field-help">无参考时文生图；角色、场景和道具参考合并去重，最多二十张。</p><div class="shot-actions"><button type="button" data-generate="image" class="project-button">生成 / 重做首帧</button><button type="button" data-generate="video" class="project-button">生成 / 重做视频</button></div></div><div class="shot-output">${qualityControlsMarkup(shot,draft)}<div class="shot-general"><label>总提示词<textarea data-field="generalPrompt" rows="6" maxlength="6000" placeholder="在这里一次写清人物、场景、构图、动作、运镜和声音。例如：主角坐在餐厅桌旁，中景平视，缓缓端起水杯喝一口，固定机位，暖色灯光，轻微杯子碰桌声。">${h(shot.generalPrompt)}</textarea></label><p class="field-help">填写后以总提示词为准，无需逐项填写左侧；人物参考、项目画风、画幅和时长继续沿用。全片环境资料不会默认注入；本镜头环境仍可单独指定。清空后恢复左侧细项。</p><div class="shot-general-actions"><button type="button" data-quick-generate="image" class="project-button">生成首帧</button><button type="button" data-quick-generate="video" class="project-button">生成视频</button><button type="button" data-quick-generate="both" class="project-button accent">一键生成首帧＋视频</button></div><p class="field-help">一键生成会重新生成并自动确认新首帧，然后生成视频；也可先生成首帧，选好并确认后再生成视频。</p></div><div class="shot-review" data-shot-review="${shot.id}"></div><div class="shot-results"></div></div></div></article>`;
}
function renderResults() {
  if (!snapshot || !$('#project-queue')) return;
  const isWorking = working();
  videoChoices();
  $('#delete-project').disabled = isWorking || snapshot.exports.some(item => item.status === 'running') || snapshot.jobs.some(item => ['submitting', 'queued', 'running', 'recovering'].includes(item.status));
  for (const node of document.querySelectorAll('#project-name,#project-video-template,.project-characters input,.project-characters textarea,.project-characters button,[data-shot-character],[data-project-video],[data-prompt-field],#project-script,#save-project,#add-shot,.shot-settings textarea,.shot-general textarea,.shot-settings input,.shot-heading input,.shot-heading button:not([data-toggle-shot])')) node.disabled = isWorking;
  $('#batch-images').disabled = isWorking;
  $('#batch-videos').disabled = isWorking;
  $('#export-project').disabled = isWorking || !snapshot.project.shots.length || snapshot.project.shots.some(shot => !videoReady(shot)) || snapshot.exports.some(item => item.status === 'running');
  $('#pause-batch').textContent = snapshot.paused ? '继续队列' : '暂停队列';
  const waiting = snapshot.queue.filter(item => ['waiting', 'dispatched'].includes(item.status));
  const latestAttempts = new Map();
  for (const item of snapshot.queue) latestAttempts.set(`${item.shotId}:${item.kind}`, item);
  const failures = snapshot.queue.filter(item => item.status === 'failed' && latestAttempts.get(`${item.shotId}:${item.kind}`) === item);
  const signature = JSON.stringify([snapshot.paused, snapshot.queue.map(item => [item.id, item.status, item.error]), snapshot.jobs.map(item => [item.id, item.status, item.error])]);
  if (signatures.get('queue') !== signature) {
    $('#project-queue').innerHTML = `${snapshot.paused ? '<p class="notice">队列已暂停，正在运行的任务会继续。确认后点击“继续队列”。</p>' : ''}${waiting.length ? `<div class="queue-list">${waiting.map(item => { const shot = snapshot.project.shots.find(shot => shot.id === item.shotId); const task = job(item.id); return `<div><span>${h(shot?.title)} · ${item.kind === 'image' ? '首帧' : '视频'}${item.comparison?' · 对比'+(item.input.template==='h3-base'?'20步':'8步')+' · 种子'+item.input.seed:''} · ${names[task?.status || item.status]}</span>${item.status === 'waiting' ? `<button type="button" data-cancel-queue="${item.id}">取消待执行项</button>` : `<button type="button" data-stop-job="${item.id}">停止此任务</button>`}</div>`; }).join('')}</div>` : ''}${failures.slice(-3).map(item => `<p class="notice error">${h(snapshot.project.shots.find(shot => shot.id === item.shotId)?.title)}：${h(item.error || '生成失败，可单独重做。')}</p>`).join('')}`;
    signatures.set('queue', signature);
  }
  for (const [index, shot] of snapshot.project.shots.entries()) {
    const container = document.querySelector(`[data-shot="${shot.id}"] .shot-results`);
    if (!container) continue;
    const choice = frameChoices.get(shot.id);
    if (choice && !shot.imageHistory.includes(choice)) frameChoices.delete(shot.id);
    const image = job(frameChoices.get(shot.id) || shot.imageJobId);
    const video = job(shot.videoJobId);
    const previous = snapshot.project.shots[index - 1];
    const canContinue = previous && videoReady(previous);
    const characterSignature = snapshot.characterSignatures?.[shot.id];
    const plan = snapshot.plans?.find(item => item.shotId === shot.id);
    const isExternal = externalFrame(image), confirmed = isExternal ? approvedExternal(shot,image) : shot.confirmedFrameJobId === image?.id && !!image;
    const staleCharacter = !isExternal&&image?.status==='success'&&!matchesCharacter(shot,image);
    const checkExternal = confirmed&&isExternal&&plan?.frameSignature&&shot.frameApproval?.frameSignature!==plan.frameSignature;
    const key = JSON.stringify([characterSignature, plan?.frameSignature, plan?.videoSignature, shot, image?.id, image?.status, image?.error, image?.outputs?.[0]?.sha256, video?.status, video?.error, snapshot.jobs.filter(j=>j.enhancement&&j.shotId===shot.id).map(j=>[j.id,j.status,j.progress]), isWorking, previous?.id, previous?.videoJobId, canContinue]);
    if (signatures.get(shot.id) === key) continue;
    signatures.set(shot.id, key);
    container.innerHTML = `<div class="shot-image-result">${staleCharacter ? '<p class="notice error">首帧对应的设定或提示词已变化，请重做并确认首帧。</p>' : ''}${checkExternal?'<p class="notice">设定或提示词已变化，请人工核对此外部首帧。原图仍可使用；无需强制重绘。</p>':''}<div class="frame-result-heading"><h3>候选首帧 <span>${confirmed ? '已确认' : '待确认'}</span></h3><button type="button" class="project-button frame-import-button" data-import-frame>导入／选用首帧</button></div>${image?.outputs[0] ? `<img src="${image.outputs[0].url}" alt="${h(shot.title)}的候选首帧">` : `<div class="shot-placeholder">${image ? names[image.status] : '尚未生成首帧'}</div>`}<p class="frame-drop-help">可拖入一张外部图片，加入本镜头候选。</p><select aria-label="首帧版本" class="image-version" ${isWorking ? 'disabled' : ''}>${shot.imageHistory.map(id => job(id)).filter(item => item?.status === 'success').map((item, i) => `<option value="${item.id}" ${item.id === image?.id ? 'selected' : ''}>首帧版本 ${i + 1} · ${externalFrame(item) ? '外部导入 · '+h(item.externalFrame?.name||'图片') : item.sourceVideoJobId ? '上一段尾帧' : '种子 ' + item.seed}</option>`).join('')}</select>${index > 0 ? `<button type="button" data-use-previous-tail class="project-button" ${!canContinue || isWorking ? 'disabled' : ''}>使用上一段尾帧</button><p class="field-help">${image?.sourceVideoJobId ? (image.sourceVideoJobId === previous.videoJobId ? '当前首帧来自上一段视频的最后一帧，已自动确认。' : '当前首帧来自旧视频的尾帧；上一段版本已变化，可重新提取。') : '上一镜头视频完成后，可用它的最后一帧接着生成本镜头。'}</p>` : ''}<button type="button" data-confirm-frame class="project-button" ${!shot.imageHistory.some(id => job(id)?.status === 'success') || isWorking ? 'disabled' : ''}>确认所选首帧</button></div><div class="shot-video-result"><h3>视频 <span>${video ? names[video.status] : `${((shot.frames||normalizeVideoOptions(draft.video).frames) / 24).toFixed(2)} 秒`}</span></h3>${video?.outputs[0] ? `<video src="${video.outputs[0].url}" controls playsinline preload="metadata" aria-label="${h(shot.title)}的视频"></video>` : `<div class="shot-placeholder">${video ? names[video.status] : '确认首帧后生成'}</div>`}${video?.status === 'success' && !videoReady(shot) ? '<p class="field-help">此视频的首帧或视频设置与当前选择不一致，可切回对应版本或重新生成。</p>' : ''}<select aria-label="视频版本" class="video-version" ${isWorking ? 'disabled' : ''}><option value="">选择使用的视频版本</option>${shot.videoHistory.map(id => job(id)).filter(item => item?.status === 'success').map((item, i) => `<option value="${item.id}" ${item.id === shot.videoJobId ? 'selected' : ''}>视频版本 ${i + 1}${item.enhancement?' · AI精修'+h(item.enhancement.target):''}${item.comparison?' · 对比 '+(item.template==='h3-base'?'20步':'8步')+' · 种子 '+item.seed:''}</option>`).join('')}</select>${video?.outputs[0] ? `<a href="${video.outputs[0].url}" target="_blank" rel="noopener" class="project-button">查看视频原文件</a>` : ''}${video?.outputs?.[0]?.metadata?`<p class="field-help">实际文件：${video.outputs[0].metadata.width||'?'}×${video.outputs[0].metadata.height||'?'}${video.enhancement?' · AI精修输出':' · 原生生成'}</p>`:''}${upscaleMarkup(video,snapshot.jobs)}${image?.error || video?.error ? `<p class="field-help">${h(image?.error || video?.error)}</p>` : ''}</div>`;
    const card=container.closest('[data-shot]');
    for(const button of card.querySelectorAll('[data-generate="video"],[data-quick-generate="video"]'))button.textContent=isExternal?'用当前首帧生成视频':button.hasAttribute('data-quick-generate')?'生成视频':'生成 / 重做视频';
  }
  for (const button of document.querySelectorAll('[data-generate],[data-quick-generate]')) button.disabled = isWorking;
  const exportSignature = JSON.stringify(snapshot.exports);
  if (signatures.get('exports') !== exportSignature) {
    $('#project-exports').innerHTML = snapshot.exports.length ? `<h2>成片导出</h2>${snapshot.exports.map(item => `<div class="project-export"><span>${h(item.title)} · ${names[item.status]} ${item.status === 'running' ? `${item.completed}/${item.total} 段` : ''}</span>${item.status === 'success' ? `<video src="/api/exports/${item.id}/file" controls preload="metadata" playsinline aria-label="项目成片"></video><a class="project-button accent" href="/api/exports/${item.id}/file" target="_blank" rel="noopener">查看成片原文件 ↗</a><small>${item.metadata?.frames ?? ''} 帧 · ${item.metadata?.duration?.toFixed(2) ?? ''} 秒</small>` : item.error ? `<p class="notice error">${h(item.error)}</p>` : ''}</div>`).join('')}` : '';
    signatures.set('exports', exportSignature);
  }
  updateProductionUI();
}
async function saveProject() {
  if (working()) return;
  if(saving){await saving;if(dirty)return saveProject();return;}
  clearTimeout(saveTimer);const version=revision,id=currentId,payload=structuredClone(draft);saveStatus('正在保存…');
  saving=(async()=>{const saved=await api('/api/projects/'+id,payload);if(currentId!==id)return;if(version===revision){draft=saved;dirty=false;}const item=projects.find(item=>item.id===id);if(item)item.name=saved.name;await load(false);saveStatus(dirty?'有未保存修改':'已自动保存');})();
  try{await saving;}finally{saving=null;if(dirty)scheduleSave();}
}
async function batch(kind, shotId) {
  if(kind==='both'&&snapshot.project.shots.some(shot=>(!shotId||shot.id===shotId)&&externalFrame(job(frameChoices.get(shot.id)||shot.imageJobId)))&&!confirm('本镜头已有外部首帧。\n\n“一键生成首帧＋视频”会重新生成一张图片并自动确认，再生成视频。若要使用当前导入的图片，请取消，并点击“用当前首帧生成视频”。\n\n继续重新生成图片和视频？'))return;
  if (kind === 'video') {
    for (const shot of snapshot.project.shots.filter(shot => shotId ? shot.id === shotId : !videoReady(shot))) {
      const choice = frameChoices.get(shot.id) || shot.imageJobId;
      if (choice && choice !== shot.confirmedFrameJobId) throw new Error(`镜头「${shot.title}」所选首帧尚未确认，请先点击“确认所选首帧”，再生成视频。`);
    }
  }
  await saveProject();
  const shots = snapshot.project.shots;
  const ids = shotId ? [shotId] : shots.filter(shot => kind === 'image' ? job(shot.imageJobId)?.status !== 'success' || !matchesCharacter(shot, job(shot.imageJobId)) : !videoReady(shot)).map(shot => shot.id);
  if (!ids.length) { notice('没有待生成的镜头。需要重做时，请使用镜头内的按钮。'); return; }
  await api(`/api/projects/${currentId}/batch`, { requestId: crypto.randomUUID(), kind, shotIds: ids });
  if (kind !== 'video') for (const id of ids) frameChoices.delete(id);
  notice(kind==='both'?'已加入串行队列：生成新首帧 → 自动确认 → 生成视频。首帧失败时会停止后续视频。':'已加入串行队列。首帧生成完成后，请逐张确认，再生成视频。'); await load(false);
}
$('#projects-panel').addEventListener('input', event => {
  if(productionInput(event.target))return;
  if(['project-name','project-script'].includes(event.target.id)){changed();return;}
  if (event.target.dataset.characterField) { const role = draft.characters.find(item => item.id === event.target.closest('[data-character]').dataset.character); role[event.target.dataset.characterField] = event.target.value; changed();return; }
  const card = event.target.closest('[data-shot]');
  if (!card) return;
  const shot = draft.shots.find(shot => shot.id === card.dataset.shot);
  if (event.target.dataset.field) { shot[event.target.dataset.field] = event.target.value;changed(); }
});
$('#projects-panel').addEventListener('change', event => {
  if (event.target.dataset.characterRef) {
    const card = event.target.closest('[data-character]');
    const role = draft.characters.find(item => item.id === card.dataset.character);
    const ids = [...card.querySelectorAll('[data-character-ref]:checked')].map(input => input.dataset.characterRef);
    if (ids.length > 20) { event.target.checked = false; notice('每个角色最多二十张固定参考；每镜全部参考合计不超过二十张。', true); return; }
    role.referenceIds = ids; card.querySelector('details summary').textContent = `固定参考图（已选 ${ids.length} / 20）`; changed();return;
  }
  if (event.target.id === 'project-choice') return void perform(async () => {if(dirty)await saveProject();currentId = event.target.value; await load(true); });
  if(event.target.id==='project-video-template'){if(draft.videoTemplate==='h3-reference'){draft.video={...normalizeVideoOptions(draft.video),frames:73,profile:'draft',aspect:'landscape'};changed();render();renderResults();}else changed();return;}
  if (event.target.dataset.projectVideo) {
    const selects = [...document.querySelectorAll('[data-project-video]')];
    const video = { ...normalizeVideoOptions(draft.video), ...Object.fromEntries(selects.map(node => [node.dataset.projectVideo, node.value])) };
    const profile = selects.find(node => node.dataset.projectVideo === 'profile');
    try{draft.video = normalizeVideoOptions(video);}catch(error){event.target.value=String(draft.video[event.target.dataset.projectVideo]);notice(error.message,true);return;}
    for (const [value, title] of Object.entries(videoProfileLabels(draft.video))) { const option=profile.querySelector(`[value="${value}"]`);if(option)option.textContent=title; }
    videoChoices();
    changed();return;
  }
  const card = event.target.closest('[data-shot]');
  if (!card) return;
  const shot = draft.shots.find(shot => shot.id === card.dataset.shot);
  if (event.target.dataset.shotCharacter) { shot.characterIds = [...card.querySelectorAll('[data-shot-character]:checked')].map(input => input.dataset.shotCharacter); changed();return; }
  if(event.target.dataset.shotGroup){const group=draft.catalog.find(g=>g.id===event.target.dataset.shotGroup);const all=new Set(shot.referenceIds);for(const id of group.defaultReferenceIds)if(event.target.checked)all.add(id);else all.delete(id);shot.referenceIds=[...all];changed();render();renderResults();return;}
  if (event.target.dataset.ref) {
    const refs = [...card.querySelectorAll('[data-ref]:checked')].map(input => input.dataset.ref);
    if (refs.length > 20) { event.target.checked = false; notice('每个镜头最多二十张参考图。', true); return; }
    shot.referenceIds = refs;
    changed();
  }
  if (event.target.matches('.image-version')) {
    frameChoices.set(shot.id, event.target.value); renderResults();
  }
  if (event.target.matches('.video-version') && event.target.value) void perform(async () => { await api(`/api/projects/${currentId}/select`, { shotId: shot.id, kind: 'video', jobId: event.target.value,adoptComparison:!!job(event.target.value)?.comparison }); await load(true); });
});
$('#projects-panel').addEventListener('click', event => {
  const button = event.target.closest('button'); if (!button) return;
  if(button.hasAttribute('data-import-frame')){showFrameImport(button.closest('[data-shot]').dataset.shot);return;}
  if (button.hasAttribute('data-toggle-shot')) {
    event.preventDefault();
    const card = button.closest('[data-shot]'), content = card.querySelector('.shot-content');
    const collapsed = !content.hidden;
    content.hidden = collapsed;
    button.textContent = collapsed ? '▸' : '▾';
    button.setAttribute('aria-expanded', String(!collapsed));
    button.title = collapsed ? '展开镜头内容' : '收起镜头内容';
    button.setAttribute('aria-label', button.title);
    if (collapsed) {
      localStorage.setItem(shotCollapseKey(card.dataset.shot), '1');
      for (const media of content.querySelectorAll('video,audio')) media.pause();
    } else localStorage.removeItem(shotCollapseKey(card.dataset.shot));
    return;
  }
  void perform(async () => {
    if(button.dataset.upscale&&dirty)await saveProject();
    if(await upscaleClick(button,api,()=>load(false)))return;
    if(await productionClick(button))return;
    if(button.hasAttribute('data-inherit-assets')){const card=button.closest('[data-shot]'),index=draft.shots.findIndex(s=>s.id===card.dataset.shot);if(index<1)throw Error('第一镜头没有上一镜素材。');const previous=draft.shots[index-1],shot=draft.shots[index];shot.characterIds=[...(previous.characterIds||draft.characters.map(r=>r.id))];shot.referenceIds=[...previous.referenceIds];shot.inheritReferences=previous.inheritReferences;changed();render();renderResults();return;}
    if(button.dataset.quickGenerate){await batch(button.dataset.quickGenerate,button.closest('[data-shot]').dataset.shot);return;}
    if (button.id === 'add-character') {
      draft.characters ??= []; const old = [...draft.characters];
      const role = {id:crypto.randomUUID(),name:`角色 ${old.length + 1}`,description:'',referenceIds:[]}; draft.characters.push(role);
      for (const shot of draft.shots) if (shot.characterIds && old.length === shot.characterIds.length && old.every(item => shot.characterIds.includes(item.id))) shot.characterIds.push(role.id);
      changed();
      render(); renderResults();
    } else if (button.dataset.deleteCharacter) {
      draft.characters = draft.characters.filter(item => item.id !== button.dataset.deleteCharacter);
      for (const shot of draft.shots) if (shot.characterIds) shot.characterIds = shot.characterIds.filter(id => id !== button.dataset.deleteCharacter);
      changed();
      render(); renderResults();
    } else if (button.id === 'delete-project') {
      if (!draft || !confirm(`删除项目“${draft.name}”？\n\n将永久删除此项目、专属素材及其图片、视频和成片。\n相关镜头引用会同步清理。公共素材库中独立保存的参考原件保留；不会创建媒体备份。`)) return;
      if (dirty || saving) await saveProject();
      const removedId = currentId;
      await api('/api/projects/' + removedId, {}, 'DELETE');
      clearTimeout(saveTimer); dirty = false;
      localStorage.removeItem('aigc-step-' + removedId); localStorage.removeItem('aigc-project');
      projects = await api('/api/projects'); currentId = projects[0]?.id || '';
      await load(true); notice('项目及其生成文件已彻底删除，相关引用已清理。');
    } else if (button.id === 'new-project') {
      if(dirty)await saveProject();const created = await api('/api/projects', { name: $('#new-project-name').value,production:normalizeProduction({},assets) });
      projects.push(created); currentId = created.id; await load(true);
    } else if (button.id === 'add-asset') {
      const file = $('#asset-file').files[0];
      if (!file) throw new Error('请选择素材图片。');
      if (!$('#asset-name').value.trim()) throw new Error('请填写素材名称。');
      if (file.size > 20 * 1024 * 1024) throw new Error('素材图片上限为 20MB。');
      const response = await fetch('/api/uploads', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
      const uploaded = await response.json(); if (!response.ok) throw new Error(uploaded.error);
      await api('/api/assets', { uploadId: uploaded.id, name: $('#asset-name').value, category: $('#asset-category').value });
      assets = await api('/api/assets');
      if (draft) await saveProject();
      await load(true); $('#projects-panel .asset-library').open = true; notice('素材已保存。');
    } else if (button.id === 'save-project') { await saveProject(); render(); renderResults(); notice('项目已保存。'); }
    else if (button.id === 'add-shot') {
      draft.shots.push({ id: crypto.randomUUID(), title: `镜头 ${draft.shots.length + 1}`, imagePrompt: defaultImage, videoPrompt: defaultVideo, seed: '', referenceIds: [], imageHistory: [], videoHistory: [] });
      changed();
      render(); renderResults();
    } else if (button.id === 'batch-images') await batch('image');
    else if (button.id === 'batch-videos') await batch('video');
    else if (button.id === 'pause-batch') { await api('/api/batch-queue/pause', { paused: !snapshot.paused }); await load(false); }
    else if (button.id === 'export-project') { await saveProject(); await api(`/api/projects/${currentId}/export`, {}); await load(false); }
    else if (button.dataset.cancelQueue) { await api(`/api/batch-queue/${button.dataset.cancelQueue}/cancel`, {}); await load(false); }
    else if (button.dataset.stopJob) { await api('/api/batch-queue/pause', { paused: true }); await api(`/api/jobs/${button.dataset.stopJob}/cancel`, {}); await load(false); }
    else {
      const card = button.closest('[data-shot]'); if (!card) return;
      const index = draft.shots.findIndex(shot => shot.id === card.dataset.shot);
      if (button.dataset.promptField) {
        const shot = draft.shots[index]; const field = button.dataset.promptField;
        showPromptPicker({ kind: field === 'imagePrompt' ? 'image' : 'video', onApply: body => { shot[field] = body; card.querySelector(`[data-field="${field}"]`).value = body; changed();notice('已套用，将自动保存。'); } });
      } else if (button.hasAttribute('data-remove')) { draft.shots.splice(index, 1);changed(); render(); renderResults(); }
      else if (button.dataset.move) {
        const next = index + Number(button.dataset.move);
        if (next >= 0 && next < draft.shots.length) [draft.shots[index], draft.shots[next]] = [draft.shots[next], draft.shots[index]];
        changed();
        render(); renderResults();
      } else if (button.dataset.generate) await batch(button.dataset.generate, card.dataset.shot);
      else if (button.hasAttribute('data-use-previous-tail')) {
        await saveProject();
        await api(`/api/projects/${currentId}/use-previous-tail`, { shotId: card.dataset.shot });
        await load(true);
        notice('已将上一段视频最后一帧设为并确认本镜头首帧，可以直接生成下一段。');
      }
      else if (button.hasAttribute('data-confirm-frame')) { const jobId=card.querySelector('.image-version').value; await saveProject(); await api(`/api/projects/${currentId}/select`, { shotId: card.dataset.shot, kind: 'image', jobId }); await load(false); notice('所选首帧已确认，生成视频将使用这一版。'); }
    }
  });
});
$('#projects-panel').addEventListener('dragover',event=>{const target=event.target.closest('.shot-image-result');if(!target||!event.dataTransfer.types.includes('Files'))return;event.preventDefault();event.dataTransfer.dropEffect='copy';target.classList.add('frame-drag-over');});
$('#projects-panel').addEventListener('dragleave',event=>{const target=event.target.closest('.shot-image-result');if(target&&!target.contains(event.relatedTarget))target.classList.remove('frame-drag-over');});
$('#projects-panel').addEventListener('drop',event=>{const target=event.target.closest('.shot-image-result');if(!target)return;event.preventDefault();target.classList.remove('frame-drag-over');if(event.dataTransfer.files.length!==1){notice('一次请拖入一张首帧图片。',true);return;}showFrameImport(target.closest('[data-shot]').dataset.shot,event.dataTransfer.files[0]);});
let polling = false;
setInterval(async () => {
  if (!visible || !currentId || polling || busy) return;
  polling = true;
  try { await load(false); } catch (error) { notice(error.message, true); }
  finally { polling = false; }
}, 2500);
