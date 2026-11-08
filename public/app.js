import { openProjects, closeProjects } from './projects.js';
import { upscaleMarkup,upscaleClick } from './upscale.js';
import { showPromptPicker, openPromptPage } from './prompts.js';
import { cameras, actions, styles, normalizeVideoOptions, composeVideoPrompt, videoDurations, videoProfileLabels, videoResolutionLabel,videoSpecification } from './video-options.js';
localStorage.removeItem('aigc-video-mode');
const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const labels = { video: '视频创作', image: '图片创作', reference: '人物参考', works: '我的作品' };
const statusNames = { submitting: '提交中', queued: '排队中', running: '生成中', recovering: '正在恢复连接', success: '已完成', failed: '失败', cancelled: '已停止' };
const active = new Set(['submitting', 'queued', 'running', 'recovering']);
let section = 'video';
let templates = [];
let jobs = [];
let connected = false;
let sending = false;
let uploading = 0;
let selectedJob;
let lastPreview = '';
const uploaded = new Map();
const selectedTemplates = {};
let polling = false;
const selectedWorks = new Set();
let deletingWorks = false;
function videoBase(template) { return template.maxImages||template.images === 2 ? template.defaultPrompt : '基于首帧画面，保持主体的外观、服装和场景一致，动作自然连贯。'; }
function optionSelect(key, label, choices, value) { return `<label>${label}<select data-video="${key}">${Object.entries(choices).map(([id, name]) => `<option value="${id}" ${String(value) === id ? 'selected' : ''}>${name}</option>`).join('')}</select></label>`; }
function renderVideoOptions() {
  const ref=currentTemplate()?.id==='h3-reference';
  $('#video-options').innerHTML = [
    optionSelect('frames', '视频时长', ref?Object.fromEntries(Object.entries(videoDurations).filter(([n])=>Number(n)<=124)):videoDurations, ref?73:124),
    optionSelect('aspect', '画面比例', ref?{square:'方形 1:1',portrait:'竖版',landscape:'横版'}:{ source: '跟随首帧', square: '方形 1:1', portrait: '竖版', landscape: '横版' }, ref?'landscape':'source'),
    optionSelect('profile', '生成分辨率', ref?{draft:'省显存 · 实验'}:videoProfileLabels({ frames: 124, aspect: 'source' }), ref?'draft':'standard'),
    optionSelect('sound', '输出声音', { keep: '保留模型声音', mute: '静音视频' }, 'keep'),
    optionSelect('camera', '镜头运动', cameras, 'static'), optionSelect('action', '主体动作', actions, 'blink'),
    optionSelect('style', '视觉风格', styles, 'preserve'), optionSelect('shot', '景别', { none: '保持原构图', close: '特写', medium: '中景', wide: '远景' }, 'none'),
    optionSelect('pace', '运动节奏', { none: '由描述决定', slow: '缓慢克制', normal: '自然节奏' }, 'slow')
  ].join('');
}
function selectedVideo() { return normalizeVideoOptions(Object.fromEntries([...document.querySelectorAll('[data-video]')].map(select => [select.dataset.video, select.value]))); }
function updatePromptPreview() {
  if (section !== 'video') return;
  const video = selectedVideo();
  const nativeOption=document.querySelector('[data-video="profile"] option[value="native720"]');if(nativeOption)nativeOption.disabled=video.frames>124||video.aspect==='source';
  for(const option of document.querySelectorAll('[data-video="frames"] option'))option.disabled=video.profile==='native720'&&Number(option.value)>124;
  const sourceOption=document.querySelector('[data-video="aspect"] option[value="source"]');if(sourceOption)sourceOption.disabled=video.profile==='native720';
  for (const [profile, title] of Object.entries(videoProfileLabels(video))) { const option=document.querySelector(`[data-video="profile"] option[value="${profile}"]`);if(option)option.textContent=title; }
  $('#video-option-help').textContent = currentTemplate()?.maxImages ? `生成规格：${videoResolutionLabel(video)}。多参考实验仅开放已验证的约 3～5 秒省显存档；参考图用于主体与构图约束，不强制作为首帧。` : `原生生成：${videoSpecification(video).description}。${video.frames<124?'约3秒为实验短片，建议先用5.17秒验证动作和口型。':''}原生720p档限3～5秒，需要更多显存。固定比例会居中裁切首帧，高清精修属于后处理。`;
  $('#composed-prompt').textContent = composeVideoPrompt($('#prompt').value, video);
  $('#video-specs').innerHTML = `<span>${(video.frames / 24).toFixed(2)} 秒 / ${video.frames} 帧</span><span>24 FPS</span><span>${videoResolutionLabel(video)}</span><span>${video.sound === 'mute' ? '静音' : '保留声音'}</span>`;
}

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败，请重试。');
  return data;
}
const post = (path, data) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
function notice(message, isError = false) {
  $('#notice').hidden = !message;
  $('#notice').textContent = message;
  $('#notice').className = 'notice ' + (isError ? 'error' : 'success');
}
function currentTemplate() { return templates.find(item => item.id === $('#template').value); }
function imagesFor(template) {
  if (!uploaded.has(template.id)) uploaded.set(template.id, Array(template.images).fill(null));
  return uploaded.get(template.id);
}
function updateButton() {
  const template = currentTemplate();
  const busy = jobs.some(job => active.has(job.status));
  $('#generate').disabled = !connected || !template?.available || sending || uploading > 0 || busy || imagesFor(template).some(image => !image);
  $('#generate-label').textContent = sending ? '正在提交…' : busy ? '任务处理中…' : section === 'video' ? '开始生成视频' : '开始生成图片';
}
function uploadMarkup(template) {
  if (!template.images) return '';
  const names = template.maxImages ? ['上传主体参考（多参考请在镜头项目设置）'] : template.images === 3 ? ['正面参考', '侧面参考', '全身参考'] : template.images === 2 ? (section === 'video' ? ['视频首帧', '视频尾帧'] : ['参考图片 1', '参考图片 2']) : [section === 'video' ? '上传视频首帧' : '上传原图'];
  const items = imagesFor(template);
  return `<label class="field-label">${template.images === 3 ? '三张人物参考' : section === 'video' ? '起始画面' : '参考图片'}</label><div class="${template.images === 3 ? 'upload-grid' : ''}">${names.map((name, i) => `<label class="upload-card ${template.images === 1 ? 'single' : ''}" for="upload-${i}">${items[i] ? `<img src="${escape(items[i].url)}" alt="${name}"><span class="file-overlay">${name} · 点击更换</span>` : `<span class="upload-plus" aria-hidden="true">＋</span><span>${name}</span><small>${template.images === 3 ? '点击选择图片' : 'PNG / JPG / WebP · 最大 20MB'}</small>`}<input class="file-input" id="upload-${i}" type="file" accept="image/png,image/jpeg,image/webp" aria-label="${name}" data-upload="${i}"></label>`).join('')}</div>${template.images === 3 ? '<p class="field-help">请使用同一个人的清晰原图；三图参考仍可能改变五官。</p>' : ''}`;
}
function renderTemplate() {
  const template = currentTemplate();
  if (!template) return;
  selectedTemplates[section] = template.id;
  $('#template-description').textContent = template.description;
  $('#prompt').value = section === 'video' ? videoBase(template) : template.defaultPrompt;
  $('#prompt-count').textContent = `${$('#prompt').value.length} / 6000`;
  $('#uploads').innerHTML = uploadMarkup(template);
  if(template.maxImages)$('#uploads .field-label').textContent='主体参考（不强制作为首帧）';
  $('#size-row').hidden = section === 'video';
  $('#video-specs').hidden = section !== 'video';
  $('#video-options').hidden = section !== 'video';
  $('#video-option-help').hidden = section !== 'video';
  $('#final-prompt-preview').hidden = section !== 'video';
  if (section === 'video') { renderVideoOptions(); updatePromptPreview(); }
  $('#template-issues').hidden = !template.issues.length;
  $('#template-issues').textContent = template.issues.join('\n');
  $('#submit-help').textContent = section === 'video' ? '首次加载模型可能较慢，请保持 ComfyUI 运行。' : '先生成候选图片，满意后可用作视频首帧。';
  updateButton();
}
function switchSection(value) {
  section = value;
  document.querySelectorAll('[data-section]').forEach(button => button.classList.toggle('selected', button.dataset.section === value));
  $('#projects-panel').hidden = value !== 'projects';
  $('#prompts-panel').hidden = value !== 'prompts';
  $('.recent-section').hidden = ['projects', 'prompts'].includes(value);
  if (value === 'prompts') {
    closeProjects(); $('#create-panel').hidden = true;
    $('#breadcrumb').textContent = '提示词库'; $('#page-title').innerHTML = '让已有积累，参与创作<span>。</span>';
    $('#page-subtitle').textContent = '搜索原有资料、预览与编辑描述，收藏常用模板。';
    openPromptPage(); return;
  }
  if (value === 'projects') {
    $('#create-panel').hidden = true;
    $('#breadcrumb').textContent = '镜头项目';
    $('#page-title').innerHTML = '从镜头，走向成片<span>。</span>';
    $('#page-subtitle').textContent = '整理参考素材，确认首帧，逐镜头生成，再拼接成片。';
    void openProjects(); return;
  }
  closeProjects();
  $('#breadcrumb').textContent = labels[value];
  $('#create-panel').hidden = value === 'works';
  $('#view-all').hidden = value === 'works';
  $('#recent-title').textContent = value === 'works' ? '全部作品与任务' : '最近作品';
  $('#recent-description').textContent = value === 'works' ? '成品、失败原因与生成参数，都可以在这里查看。' : '每一次创作，都留有记录。';
  const titles = { video: '让想象，开始流动', image: '把灵感，变成画面', reference: '为角色，找到下一帧', works: '每一次创作，都在这里' };
  const subtitles = { video: '从一张图片出发，完成属于你的下一段影像。', image: '用文字描述画面，或在原图上继续创作。', reference: '将三张人物参考变成候选首帧，再进入视频创作。', works: '回看你的作品，让下一次创作有迹可循。' };
  $('#page-title').innerHTML = `${titles[value]}<span>。</span>`;
  $('#page-subtitle').textContent = subtitles[value];
  $('#preview-footer-text').textContent = value === 'video' ? 'IMAGE → VIDEO' : 'IDEA → IMAGE';
  if (value !== 'works') {
    const choices = templates.filter(item => item.section === value);
    $('#template').innerHTML = choices.map(item => `<option value="${item.id}">${escape(item.name)}</option>`).join('');
    if (selectedTemplates[value]) $('#template').value = selectedTemplates[value];
    renderTemplate();
    selectedJob = jobs.find(job => job.section === value)?.id;
    lastPreview = '';
    renderPreview();
  }
  renderJobs();
}
async function checkConnection(reloadTemplates = false) {
  const status = await api('/api/status');
  connected = status.connected;
  $('#brand-name').firstChild.textContent = status.name;
  document.title = `${status.name} · 本地创作台`;
  $('#connection-text').textContent = connected ? '生成引擎已连接' : '生成引擎未连接';
  for (const selector of ['#connection-dot', '#side-dot']) $(selector).className = 'status-dot ' + (connected ? 'online' : 'offline');
  const gpu = status.system?.devices?.[0];
  $('#gpu-name').textContent = gpu ? `${gpu.name.replace(/^cuda:\d+\s*/, '').split(' : ')[0]}` : '请先启动 ComfyUI';
  $('#gpu-name').title = $('#gpu-name').textContent;
  $('#connection-text').title = status.engineUrl;
  $('#connection-notice').hidden = connected;
  $('#connection-notice').textContent = status.error || '';
  if (reloadTemplates) {
    const previous = $('#template').value;
    templates = await api('/api/templates');
    if (!$('#template').options.length && !['projects', 'prompts'].includes(section)) switchSection(section);
    else {
      if (previous) $('#template').value = previous;
      const template = currentTemplate();
      if (template) { $('#template-issues').hidden = !template.issues.length; $('#template-issues').textContent = template.issues.join('\n'); }
    }
  }
  updateButton();
}
async function uploadFile(file) {
  if (file.size > 20 * 1024 * 1024) throw new Error('图片过大，请选择 20MB 以内的图片。');
  const response = await fetch('/api/uploads', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
$('#uploads').addEventListener('change', async event => {
  const input = event.target;
  if (!input.matches('[data-upload]') || !input.files[0]) return;
  const template = currentTemplate();
  const index = Number(input.dataset.upload);
  uploading++;
  updateButton();
  try {
    imagesFor(template)[index] = await uploadFile(input.files[0]);
    if (currentTemplate()?.id === template.id) $('#uploads').innerHTML = uploadMarkup(template);
    notice('图片已准备好，可以继续填写描述。');
  } catch (error) { notice(error.message, true); }
  finally { uploading--; updateButton(); }
});
$('#create-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (sending || $('#generate').disabled) return;
  const template = currentTemplate();
  sending = true;
  updateButton();
  try {
    const job = await post('/api/jobs', { requestId: crypto.randomUUID(), template: template.id, prompt: $('#prompt').value, images: imagesFor(template).map(image => image.id), seed: $('#seed').value, size: $('#size').value, ...(section === 'video' ? { video: selectedVideo() } : {}) });
    selectedJob = job.id;
    notice(job.status === 'failed' ? job.error : '任务已提交。模型加载阶段可能没有采样百分比，请耐心等待。', job.status === 'failed');
    await refreshJobs();
    $('#preview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) { notice(error.message, true); }
  finally { sending = false; updateButton(); }
});
function actionMarkup(job) {
  const file = job.outputs?.[0];
  return `<div class="task-actions"><button type="button" data-open-work-folder="${job.id}">打开所在文件夹</button>${file ? `<a href="${file.url}" target="_blank" rel="noopener">查看原文件</a>${file.kind === 'image' ? `<button type="button" data-use="${job.id}">用作视频首帧 ↗</button>` : ''}` : ''}${upscaleMarkup(job,jobs)}${active.has(job.status) ? `<button type="button" class="cancel" data-cancel="${job.id}">停止此任务</button>` : `<button type="button" class="delete-work" data-delete-work="${job.id}" title="彻底删除文件，并清理所有项目中的对应引用">删除</button>`}</div>`;
}
function renderPreview() {
  const job = jobs.find(item => item.id === selectedJob);
  $('#task-status').dataset.jobId = job?.id ?? '';
  $('#task-status').hidden = !job;
  if (!job) {
    const key = `empty-${section}`;
    if (lastPreview !== key) {
      $('#preview').innerHTML = `<div class="empty-state"><div class="frame-symbol"><span>${section === 'video' ? '▷' : '▧'}</span></div><h2>${section === 'video' ? '下一帧，由你创造' : '下一幅，由你定义'}</h2><p>${section === 'video' ? '上传首帧，描述动作<br>你的第一段作品将在这里出现' : '选择工作流，写下你的灵感<br>生成结果将在这里出现'}</p><div class="empty-tags"><span>${section === 'video' ? '图片输入' : '灵感输入'}</span><i>→</i><span>${section === 'video' ? '视频生成' : '图片生成'}</span></div></div>`;
      lastPreview = key;
    }
    return;
  }
  const file = job.outputs?.[0];
  const key = `${job.id}-${file?.url ?? 'pending'}`;
  if (lastPreview !== key) {
    if (file) $('#preview').innerHTML = file.kind === 'video' ? `<video src="${file.url}" controls playsinline preload="metadata" aria-label="生成的视频"></video>` : `<img src="${file.url}" alt="生成的图片">`;
    else if (job.images[0]) $('#preview').innerHTML = `<img src="/api/uploads/${escape(job.images[0])}" alt="此次任务的参考图">`;
    else $('#preview').innerHTML = '<div class="empty-state"><div class="frame-symbol"><span>▧</span></div><h2>画面正在酝酿</h2><p>模型加载与生成过程中<br>你可以在下方查看任务状态</p></div>';
    lastPreview = key;
  }
  const progress = job.progress;
  $('#task-status').innerHTML = `<div class="status-heading"><span>${escape(job.title)}</span><span class="badge ${job.status === 'failed' ? 'failed' : ''}">${statusNames[job.status]}</span></div>${active.has(job.status) && progress ? `<p>当前采样：${progress.value} / ${progress.max}（采样阶段进度）</p><progress value="${progress.value}" max="${progress.max}" aria-label="采样阶段进度"></progress>` : ''}<p>${escape(job.error || (job.status === 'success' ? '生成完成，可以预览或保存成品。' : job.status === 'running' ? `正在执行${job.node ? `节点 ${job.node}` : '工作流'}。加载模型、编码和解码阶段可能暂时没有百分比。` : job.status === 'queued' ? '任务已进入引擎队列。' : job.status === 'cancelled' ? '任务已停止。' : '正在核对任务状态。'))}</p>${actionMarkup(job)}`;
}
function renderJobs() {
  const visible = section === 'works' ? jobs : jobs.slice(0, 3);
  if (!visible.length) { $('#jobs').innerHTML = '<div class="empty-library">当前没有作品。生成后，成品与参数会显示在这里。</div>'; updateWorkSelection(); return; }
  $('#jobs').innerHTML = visible.map(job => {
    const file = job.outputs?.[0];
    const dimensions = file?.metadata?.width && file?.metadata?.height ? `${file.metadata.width}×${file.metadata.height} · ` : '';
    const thumbnail = file ? file.kind === 'video' ? `<video src="${file.url}" preload="metadata" controls playsinline aria-label="${escape(job.title)}"></video>` : `<img src="${file.url}" alt="${escape(job.title)}" loading="lazy">` : `<span class="placeholder">${statusNames[job.status]}</span>`;
    const date = new Date(job.createdAt).toLocaleString('zh-CN', { hour12: false });
    return `<article class="job-card"><div class="job-thumbnail">${thumbnail}</div><div class="job-body">${section === 'works' ? `<label class="work-select"><input type="checkbox" data-select-work="${job.id}" aria-label="选择作品：${escape(job.title)}">${active.has(job.status) ? '生成中不可选' : '选择'}</label>` : ''}<div class="job-title-row"><h3>${escape(job.title)}</h3><span class="badge ${job.status === 'failed' ? 'failed' : ''}">${statusNames[job.status]}</span></div><p>${date}</p><details><summary>描述与生成参数</summary><p>${escape(job.prompt)}</p><code>种子 ${job.seed ?? '\u2014'} · ${escape(dimensions)}${job.section === 'video' ? `${job.video?.frames ?? 124} 帧 / 24fps · ${job.video?.sound === 'mute' ? '静音' : '保留声音'}` : escape(job.size)}</code>${job.error ? `<p>${escape(job.error)}</p>` : ''}</details>${actionMarkup(job)}</div></article>`;
  }).join('');
  updateWorkSelection();
}
function updateWorkSelection() {
  const eligible = new Set(jobs.filter(job => !active.has(job.status)).map(job => job.id));
  for (const id of selectedWorks) if (!eligible.has(id)) selectedWorks.delete(id);
  $('#works-selection').hidden = section !== 'works' || !jobs.length;
  const all = $('#select-all-works');
  all.checked = eligible.size > 0 && selectedWorks.size === eligible.size;
  all.indeterminate = selectedWorks.size > 0 && selectedWorks.size < eligible.size;
  all.disabled = deletingWorks || !eligible.size;
  $('#selected-works-count').textContent = `已选择 ${selectedWorks.size} 项`;
  $('#clear-work-selection').disabled = deletingWorks || !selectedWorks.size;
  $('#delete-selected-works').disabled = deletingWorks || !selectedWorks.size;
  $('#delete-selected-works').textContent = deletingWorks ? '正在删除…' : `删除所选（${selectedWorks.size}）`;
  for (const box of document.querySelectorAll('[data-select-work]')) {
    box.checked = selectedWorks.has(box.dataset.selectWork);
    box.disabled = deletingWorks || !eligible.has(box.dataset.selectWork);
    box.closest('.job-card').classList.toggle('work-selected', box.checked);
  }
  for (const button of document.querySelectorAll('[data-delete-work]')) button.disabled = deletingWorks;
}
$('#jobs').addEventListener('change', event => {
  const id = event.target.dataset.selectWork;
  if (!id || deletingWorks) return;
  if (event.target.checked) selectedWorks.add(id); else selectedWorks.delete(id);
  updateWorkSelection();
});
$('#select-all-works').addEventListener('change', event => {
  if (deletingWorks) return;
  selectedWorks.clear();
  if (event.target.checked) for (const job of jobs) if (!active.has(job.status)) selectedWorks.add(job.id);
  updateWorkSelection();
});
$('#clear-work-selection').addEventListener('click', () => { selectedWorks.clear(); updateWorkSelection(); });
$('#delete-selected-works').addEventListener('click', async () => {
  if (deletingWorks || !selectedWorks.size) return;
  const jobIds = [...selectedWorks];
  if (!confirm(`彻底删除选中的 ${jobIds.length} 项作品？\n\n将永久删除对应图片或视频，并清理所有项目中的引用，无法通过备份恢复。`)) return;
  deletingWorks = true; updateWorkSelection();
  try {
    await post('/api/jobs/delete', { jobIds });
    if (selectedWorks.has(selectedJob)) { selectedJob = null; lastPreview = ''; }
    selectedWorks.clear();
    await refreshJobs(); notice(`已彻底删除 ${jobIds.length} 项，并清理文件与项目引用。`);
  } catch (error) { notice(error.message, true); }
  finally { deletingWorks = false; updateWorkSelection(); }
});
let jobsSignature = '';
let jobsRevision = 0;
async function refreshJobs() {
  const revision = ++jobsRevision;
  const loaded = await api('/api/jobs');
  if (revision !== jobsRevision) return;
  jobs = loaded;
  if (!selectedJob) selectedJob = jobs.find(job => job.section === section)?.id;
  renderPreview();
  const signature = JSON.stringify(jobs.map(job => [job.id, job.status, job.error, job.outputs]));
  if (signature !== jobsSignature) { renderJobs(); jobsSignature = signature; }
  updateButton();
}
document.addEventListener('click', async event => {
  const nav = event.target.closest('[data-section]');
  if (nav) { switchSection(nav.dataset.section); return; }
  const upscaleButton=event.target.closest('[data-upscale],[data-upscale-compare],[data-stop-upscale]');if(upscaleButton&&!upscaleButton.closest('#projects-panel')){try{upscaleButton.disabled=true;await upscaleClick(upscaleButton,(path,body)=>body===undefined?api(path):post(path,body),refreshJobs);if(upscaleButton.dataset.upscale)notice('高清精修已开始，完成后可对比原片与高清版。');}catch(error){notice(error.message,true);}finally{upscaleButton.disabled=false;}return;}
  const folderButton=event.target.closest('[data-open-work-folder]');if(folderButton){try{await post('/api/jobs/'+folderButton.dataset.openWorkFolder+'/folder',{});}catch(error){notice(error.message,true);}return;}
  const remove = event.target.closest('[data-delete-work]');
  if (remove) {
    if (deletingWorks) return;
    const job = jobs.find(item => item.id === remove.dataset.deleteWork);
    if (!job || !confirm(`彻底删除“${job.title}”（${new Date(job.createdAt).toLocaleString('zh-CN', { hour12: false })}）？\n\n将永久删除对应图片或视频，并清理所有项目中的引用，无法通过备份恢复。`)) return;
    deletingWorks = true; updateWorkSelection();
    try {
      await api('/api/jobs/' + job.id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
      if (selectedJob === job.id) { selectedJob = null; lastPreview = ''; }
      await refreshJobs(); notice('已彻底删除文件，并清理项目引用。');
    } catch (error) { notice(error.message, true); }
    finally { deletingWorks = false; updateWorkSelection(); }
    return;
  }
  const cancel = event.target.closest('[data-cancel]');
  if (cancel) {
    cancel.disabled = true;
    try { await post(`/api/jobs/${cancel.dataset.cancel}/cancel`, {}); notice('已请求停止此任务，正在等待引擎确认。'); await refreshJobs(); }
    catch (error) { notice(error.message, true); }
    finally { cancel.disabled = false; }
  }
  const use = event.target.closest('[data-use]');
  if (use) {
    const file = jobs.find(job => job.id === use.dataset.use)?.outputs[0];
    if (!file) return;
    use.disabled = true;
    uploading++; updateButton();
    try {
      const response = await fetch(file.url);
      if (!response.ok) throw new Error('无法读取成品，请检查生成引擎连接。');
      const blob = await response.blob();
      const image = await uploadFile(new File([blob], 'first-frame.png', { type: blob.type }));
      selectedTemplates.video = 'h3-fast';
      uploaded.set('h3-fast', [image]);
      uploaded.set('h3-base', [image]);
      switchSection('video');
      notice('已将这张作品设为视频首帧。填写动作描述后即可生成视频。');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) { notice(error.message, true); }
    finally { use.disabled = false; uploading--; updateButton(); }
  }
});
$('#template').addEventListener('change', renderTemplate);
$('#reset-prompt').addEventListener('click', () => { $('#prompt').value = section === 'video' ? videoBase(currentTemplate()) : currentTemplate().defaultPrompt; $('#prompt').dispatchEvent(new Event('input')); });
$('#prompt').addEventListener('input', () => { $('#prompt-count').textContent = `${$('#prompt').value.length} / 6000`; updatePromptPreview(); });
$('#choose-prompt').addEventListener('click', () => showPromptPicker({ kind: section === 'video' ? 'video' : 'image', onApply: body => {
  $('#prompt').value = body;
  if (section === 'video') for (const key of ['camera', 'action', 'shot', 'pace']) document.querySelector(`[data-video="${key}"]`).value = 'none';
  $('#prompt').dispatchEvent(new Event('input'));
  notice('已套用提示词，请检查主体和动作，再提交生成。');
} }));
$('#video-options').addEventListener('change', () => {
  updatePromptPreview();
});
$('#reconnect').addEventListener('click', async () => {
  $('#reconnect').disabled = true;
  try { await checkConnection(true); await refreshJobs(); notice(connected ? '已重新连接生成引擎。' : '请先启动 ComfyUI，再重新连接。', !connected); }
  catch (error) { notice(error.message, true); }
  finally { $('#reconnect').disabled = false; }
});
$('#view-all').addEventListener('click', () => switchSection('works'));
async function showRoadmap() {
  $('#roadmap-dialog').showModal();
  try { $('#roadmap-content').textContent = (await api('/api/roadmap')).content; }
  catch (error) { $('#roadmap-content').textContent = error.message; }
}
$('#show-roadmap').addEventListener('click', showRoadmap);
$('#close-roadmap').addEventListener('click', () => $('#roadmap-dialog').close());
try { await checkConnection(true); await refreshJobs(); }
catch (error) { notice(error.message, true); }
let ticks = 0;
setInterval(async () => {
  if (polling) return;
  polling = true;
  try { await refreshJobs(); if (++ticks % 5 === 0) await checkConnection(); }
  catch (error) { $('#connection-text').textContent = '创作台连接中断'; $('#connection-dot').className = 'status-dot offline'; connected = false; updateButton(); }
  finally { polling = false; }
}, 2500);
