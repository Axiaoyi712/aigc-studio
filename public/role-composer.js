import { referenceRoles, compositionStyles, compositionSizes, normalizeComposition, composeReferencePrompt } from './composition.js';

const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const active = new Set(['submitting', 'queued', 'running', 'recovering']);
const status = { submitting: '提交中', queued: '排队中', running: '生成中', recovering: '恢复连接中', success: '已完成', failed: '生成失败', cancelled: '已停止' };
export function createRoleComposerUI({ panel, api, post, notice, refreshJobs, openProject }) {
  let data = { library: [], projects: [], recipes: [] }, sources = [], refs = {}, jobs = [], connected = false, available = false, pending = false, initialized = false;
  let selectedId = '', resultSignature = '', loadRevision = 0, opening = false;
  const q = selector => panel.querySelector(selector);
  panel.innerHTML = `<div class="composer-intro"><div><span class="composer-kicker">REFERENCE → CHARACTER → FIRST FRAME</span><h2>组合参考，制作你的角色与镜头</h2><p>先选人物，再加姿势、服装或场景。系统会按每张图片的用途组织提示词。</p></div><span class="composer-engine">本机 FLUX Klein 4B</span></div>
    <div class="composer-target"><label>当前项目<select id="composer-project"><option value="">独立创作</option></select></label><label>目标镜头<select id="composer-shot"><option value="">先选择项目</option></select></label><p>选定项目和镜头后，生成图片直接保存到该镜头目录；加入候选后仍需确认首帧。</p></div>
    <div class="composer-layout"><section class="composer-settings" aria-label="角色合成设置">
      <div class="composer-step"><span>01</span><div><h3>选择参考图片</h3><p>人物 A 必选，再添加至少一种参考；同一图片只使用一次。</p></div></div>
      <div class="composer-slots" data-primary-slots></div><details class="composer-more"><summary>服装、场景与第二位人物 <span>按需添加</span></summary><div class="composer-slots" data-extra-slots></div><label class="composer-mapping" hidden>双人人物对应说明<input id="composer-mapping" maxlength="300" placeholder="例如：人物 A 在左、人物 B 在右；保持各自身份与服装"></label></details>
      <div class="composer-step"><span>02</span><div><h3>描述这幅画面</h3><p>写清表情、景别和想保留的细节，首帧描述以静态画面为主。</p></div></div>
      <label class="composer-label" for="composer-description">补充描述</label><textarea id="composer-description" rows="4" maxlength="2000" placeholder="例如：人物坐在咖啡馆窗边，手持杯子，面带克制的微笑，中景平视，暖色自然光。"></textarea>
      <div class="composer-options"><label>画风<select id="composer-style">${Object.entries(compositionStyles).map(([id, name]) => `<option value="${id}" ${id === 'realistic' ? 'selected' : ''}>${name}</option>`).join('')}</select></label><label>输出尺寸<select id="composer-size">${compositionSizes.map(size => `<option value="${size}">${size.replace('x', ' × ')}${size.includes('2048') ? ' · 原生 2K' : ''}</option>`).join('')}</select></label></div>
      <p class="field-help" id="composer-size-help">8GB 显存建议先用约百万像素试做。姿势属于参考引导，不能保证逐关节一致。</p>
      <details class="composer-prompt"><summary>查看实际图片顺序与完整提示词</summary><div data-reference-order></div><pre id="composer-prompt"></pre><button type="button" data-composer-copy>复制提示词</button></details>
      <details class="composer-recipes"><summary>保存／载入组合方案</summary><label>方案名称<input id="composer-recipe-name" maxlength="80" placeholder="例如：女主 · 咖啡馆坐姿"></label><button type="button" data-save-recipe>保存本次组合</button><label>已有方案<select id="composer-recipe"><option value="">选择组合方案</option></select></label><div class="composer-inline"><button type="button" data-load-recipe>载入方案</button><button type="button" data-delete-recipe>删除方案</button></div><p class="field-help">只保存配置与图片引用，不复制原图。载入方案不会自动提交任务。</p></details>
      <details class="composer-seed"><summary>随机种子</summary><input id="composer-seed" type="number" min="0" max="9007199254740991" step="1" placeholder="留空随机；相同种子仅便于比较"></details>
      <p class="composer-validation" id="composer-validation" role="status"></p><button type="button" class="primary" id="composer-generate">生成候选图片 <span>↗</span></button>
    </section><section class="composer-result" aria-label="角色合成结果"><div class="composer-step"><span>03</span><div><h3>选择满意的版本</h3><p>先确认人物与构图，再用于短剧镜头。</p></div></div><label>图片版本<select id="composer-result-choice"><option value="">尚未生成</option></select></label><div id="composer-result-media" class="composer-result-media"><p>选好参考、填写画面要求<br>候选图片将在这里出现</p></div><p id="composer-result-state" role="status"></p><div class="composer-result-actions" hidden><a id="composer-original" target="_blank" rel="noopener">查看原图 ↗</a><button type="button" data-adopt-frame>加入目标镜头首帧候选</button><label>项目角色名称<input id="composer-role-name" maxlength="80" placeholder="填写角色名称后保存定稿"></label><button type="button" data-save-character>保存为项目角色定稿</button><button type="button" data-open-target>前往项目确认首帧</button></div></section></div>`;

  function roleCard(role) {
    return `<article class="composer-slot" data-slot="${role.id}" tabindex="0" aria-label="${role.name}参考"><div class="composer-slot-heading"><strong>${role.name}</strong><button type="button" data-clear-role="${role.id}" aria-label="清空${role.name}" hidden>×</button></div><button type="button" class="composer-slot-preview" data-picker="${role.id}"><span>＋<small>从图库或项目中选择</small></span></button><p>${role.hint}</p><div class="composer-inline"><button type="button" data-picker="${role.id}">浏览参考</button><label class="composer-file-label" for="composer-upload-${role.id}">上传图片</label><input id="composer-upload-${role.id}" class="composer-file" type="file" data-upload-role="${role.id}" accept="image/png,image/jpeg,image/webp"></div><small data-slot-name>支持拖入、粘贴单张图片 · 最大20MB</small></article>`;
  }
  q('[data-primary-slots]').innerHTML = referenceRoles.filter(r => ['person', 'pose'].includes(r.id)).map(roleCard).join('');
  q('[data-extra-slots]').innerHTML = referenceRoles.filter(r => !['person', 'pose'].includes(r.id)).map(roleCard).join('');
  function composition() {
    return { references: Object.entries(refs).map(([role, ref]) => ({ role, uploadId: ref.uploadId, name: ref.name })), description: q('#composer-description').value, mapping: q('#composer-mapping').value, style: q('#composer-style').value, size: q('#composer-size').value, seed: q('#composer-seed').value };
  }
  function updateForm() {
    for (const role of referenceRoles) {
      const card = q(`[data-slot="${role.id}"]`), ref = refs[role.id];
      card.classList.toggle('has-reference', !!ref);
      card.querySelector('[data-clear-role]').hidden = !ref;
      card.querySelector('[data-slot-name]').textContent = ref?.name || '支持拖入、粘贴单张图片 · 最大20MB';
      const preview = card.querySelector('.composer-slot-preview');
      if (preview.dataset.uploadId !== (ref?.uploadId || '')) { preview.innerHTML = ref ? `<img src="${h(ref.url || '/api/uploads/' + ref.uploadId)}" alt="${role.name}：${h(ref.name)}">` : '<span>＋<small>从图库或项目中选择</small></span>'; preview.dataset.uploadId = ref?.uploadId || ''; }
    }
    q('.composer-mapping').hidden = !refs.personB;
    let error = '';
    try {
      const c = normalizeComposition(composition());
      q('#composer-prompt').textContent = composeReferencePrompt(c);
      q('[data-reference-order]').innerHTML = c.references.map((ref, i) => `<span>图${i + 1} · ${h(referenceRoles.find(r => r.id === ref.role).name)}：${h(ref.name)}</span>`).join('');
    } catch (e) { error = e.message; q('#composer-prompt').textContent = error; q('[data-reference-order]').innerHTML = ''; }
    q('#composer-size-help').textContent = q('#composer-size').value.includes('2048') ? '当前为原生 2K，8GB 显存可能明显变慢或不足。建议先用约百万像素确认构图；这不是后期放大。' : '8GB 显存建议先用约百万像素试做。姿势属于参考引导，不能保证逐关节一致。';
    const busy = jobs.some(job => active.has(job.status));
    q('#composer-validation').textContent = error || (!connected ? '生成引擎未连接，仍可浏览本地图库和编辑方案。' : !available ? '当前 FLUX 参考工作流不可用，请检查已有模型和节点。' : busy ? '已有任务正在处理，完成后可以提交。' : '参考已准备好，可以生成候选图片。');
    q('#composer-generate').disabled = !!error || pending || busy || !connected || !available;
    q('#composer-generate').innerHTML = pending ? '正在处理…' : '生成候选图片 <span>↗</span>';
    for (const button of panel.querySelectorAll('[data-save-recipe], [data-load-recipe], [data-delete-recipe], [data-adopt-frame], [data-save-character]')) button.disabled = pending;
    for (const input of panel.querySelectorAll('#composer-project, #composer-shot, [data-upload-role], [data-picker], [data-clear-role]')) input.disabled = pending;
  }
  function projectChoices() {
    const current = q('#composer-project').value;
    q('#composer-project').innerHTML = '<option value="">独立创作</option>' + data.projects.map(p => `<option value="${p.id}">${h(p.name)}</option>`).join('');
    if (data.projects.some(p => p.id === current)) q('#composer-project').value = current;
    shotChoices();
    const recipe = q('#composer-recipe').value;
    q('#composer-recipe').innerHTML = '<option value="">选择组合方案</option>' + data.recipes.map(r => `<option value="${r.id}">${h(r.name)}${r.missing.length ? ' · 有参考已删除' : ''}</option>`).join('');
    if (data.recipes.some(r => r.id === recipe)) q('#composer-recipe').value = recipe;
  }
  function shotChoices() {
    const current = q('#composer-shot').value, project = data.projects.find(p => p.id === q('#composer-project').value);
    q('#composer-shot').innerHTML = project ? '<option value="">选择目标镜头</option>' + project.shots.map(s => `<option value="${s.id}">${h(s.title)}</option>`).join('') : '<option value="">先选择项目</option>';
    if (project?.shots.some(s => s.id === current)) q('#composer-shot').value = current;
  }
  async function loadSources() {
    const revision = ++loadRevision, projectId = q('#composer-project').value;
    const loaded = await api('/api/composer/sources' + (projectId ? '?projectId=' + encodeURIComponent(projectId) : ''));
    if (revision === loadRevision) sources = loaded;
  }
  async function reload() { data = await api('/api/composer'); projectChoices(); await loadSources(); }
  async function perform(action) {
    if (pending) return;
    pending = true; updateForm();
    try { await action(); } catch (error) { notice(error.message, true); }
    finally { pending = false; updateForm(); }
  }
  async function upload(role, file) {
    if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || !file.size || file.size > 20 * 1024 * 1024) throw Error('请选择一张 20MB 以内的 PNG、JPEG 或 WebP 图片。');
    const response = await fetch('/api/uploads', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
    const item = await response.json(); if (!response.ok) throw Error(item.error || '上传失败。');
    const name = file.name.slice(0, 80);
    await post('/api/composer/references', { role, uploadId: item.id, name, projectId: q('#composer-project').value || null });
    refs[role] = { uploadId: item.id, name, url: item.url }; await loadSources(); updateForm();
    notice('图片已放入指定参考槽，并加入' + (q('#composer-project').value ? '当前项目的参考列表。' : '我的参考。'));
  }
  async function picker(role) {
    await reload();
    const targetRole = role === 'personB' ? 'person' : role;
    const dialog = document.createElement('dialog'); dialog.className = 'composer-gallery';
    dialog.innerHTML = `<div class="composer-gallery-heading"><div><h2>选择${h(referenceRoles.find(r => r.id === role).name)}参考</h2><p>公共图库仅收录已核对来源的 CC0 图片；项目素材只显示当前项目。</p></div><button type="button" data-close aria-label="关闭参考图库">×</button></div><div class="composer-gallery-tabs"><button type="button" data-source="library" class="selected">公共参考</button><button type="button" data-source="project">${q('#composer-project').value ? '当前项目／我的参考' : '我的参考／公共素材'}</button><a href="https://ai-pose-gallery.pages.dev/" target="_blank" rel="noopener">姿势原站 ↗</a><a href="https://ai-costume-gallery.pages.dev/" target="_blank" rel="noopener">服装原站 ↗</a></div><div class="composer-gallery-filters"><input data-search placeholder="搜索名称或分类" aria-label="搜索参考图片"><select data-category aria-label="参考分类"><option value="">全部分类</option></select><select data-view aria-label="参考视角"><option value="">全部视角</option></select><button type="button" data-random>随机选一张</button></div><p data-gallery-count class="field-help"></p><div data-gallery-grid class="composer-gallery-grid"></div><button type="button" data-more hidden>继续显示</button><p class="field-help">原站姿势、服装允许逐张用于创作参考，不做整库抓取。可下载所需图片后，用“上传图片”导入。</p>`;
    document.body.append(dialog); dialog.addEventListener('close', () => dialog.remove()); dialog.querySelector('[data-close]').onclick = () => dialog.close();
    let source = 'library', limit = 24, selectedViews = {}, filtered = [];
    const all = () => source === 'library' ? data.library.filter(item => item.role === targetRole) : sources.filter(item => !item.role || item.role === targetRole);
    function filters() {
      const items = all();
      for (const [field, selector] of [['category', '[data-category]'], ['view', '[data-view]']]) { const select = dialog.querySelector(selector); select.innerHTML = `<option value="">全部${field === 'category' ? '分类' : '视角'}</option>` + [...new Set(items.map(r => r[field]).filter(Boolean))].map(v => `<option>${h(v)}</option>`).join(''); }
    }
    function render() {
      const term = dialog.querySelector('[data-search]').value.trim().toLowerCase(), category = dialog.querySelector('[data-category]').value, view = dialog.querySelector('[data-view]').value;
      filtered = all().filter(item => (!term || (item.name + ' ' + (item.category || '')).toLowerCase().includes(term)) && (!category || item.category === category) && (!view || item.view === view));
      const groups = new Map(); for (const item of filtered) { const key = item.groupId || item.id; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item); }
      const shown = [...groups.entries()].slice(0, limit);
      dialog.querySelector('[data-gallery-count]').textContent = `${groups.size} 组 · ${filtered.length} 张图片`;
      dialog.querySelector('[data-gallery-grid]').innerHTML = shown.map(([key, items]) => { const item = items.find(r => r.id === selectedViews[key]) || items[0]; return `<article class="composer-gallery-card"><button type="button" data-enlarge="${h(item.id)}"><img loading="lazy" decoding="async" src="${h(item.url)}" alt="${h(item.name)} · ${h(item.view || '')}"></button><strong>${h(item.name)}</strong><small>${h(item.category || item.groupName || '项目素材')} · ${h(item.view || '参考')}</small>${items.length > 1 ? `<select data-group-view="${h(key)}" aria-label="${h(item.name)}的视角">${items.map(r => `<option value="${h(r.id)}" ${r.id === item.id ? 'selected' : ''}>${h(r.view)}</option>`).join('')}</select>` : ''}<div class="composer-inline"><button type="button" data-use="${h(item.id)}">使用此图</button>${item.custom ? `<button type="button" data-delete-reference="${item.id}">删除</button>` : ''}</div></article>`; }).join('') || '<div class="empty-library">暂无匹配图片。可以上传自己的参考，或调整筛选条件。</div>';
      dialog.querySelector('[data-more]').hidden = groups.size <= limit;
    }
    async function use(item) {
      if (!item || !dialog.isConnected) return;
      const ref = source === 'library' ? await post('/api/composer/library/use', { id: item.id }) : item;
      refs[role] = { uploadId: ref.uploadId, name: ref.name, url: ref.url }; updateForm(); dialog.close();
    }
    dialog.addEventListener('click', event => {
      const b = event.target.closest('button'); if (!b) return;
      if (b.dataset.source) { source = b.dataset.source; limit = 24; for (const tab of dialog.querySelectorAll('[data-source]')) tab.classList.toggle('selected', tab === b); filters(); render(); }
      else if (b.hasAttribute('data-more')) { limit += 24; render(); }
      else if (b.dataset.use) void perform(() => use(filtered.find(r => r.id === b.dataset.use)));
      else if (b.hasAttribute('data-random')) void perform(() => { if (!filtered.length) throw Error('当前筛选没有可用图片。'); return use(filtered[Math.floor(Math.random() * filtered.length)]); });
      else if (b.dataset.deleteReference) void perform(async () => { if (!confirm('彻底删除这张自定义参考原图，并清理相关引用？')) return; await api('/api/composer/references/' + b.dataset.deleteReference, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } }); await loadSources(); for (const key of Object.keys(refs)) if (!sources.some(r => r.uploadId === refs[key].uploadId) && refs[key].uploadId === filtered.find(r => r.id === b.dataset.deleteReference)?.uploadId) delete refs[key]; render(); });
      else if (b.dataset.enlarge) { const item = filtered.find(r => r.id === b.dataset.enlarge); const viewer = document.createElement('dialog'); viewer.className = 'composer-lightbox'; viewer.innerHTML = `<button type="button" aria-label="关闭大图">×</button><img src="${h(item.url)}" alt="${h(item.name)}"><p>${h(item.name)} · ${h(item.view || '')}</p><p>${h(item.source || '用户素材')} ${h(item.license || '')}</p>${item.sourceUrl ? `<a href="${h(item.sourceUrl)}" target="_blank" rel="noopener">查看来源与授权 ↗</a>` : ''}`; document.body.append(viewer); viewer.querySelector('button').onclick = () => viewer.close(); viewer.onclose = () => viewer.remove(); viewer.showModal(); }
    });
    dialog.addEventListener('input', event => { if (event.target.matches('[data-search]')) { limit = 24; render(); } });
    dialog.addEventListener('change', event => { if (event.target.dataset.groupView) selectedViews[event.target.dataset.groupView] = event.target.value; else limit = 24; render(); });
    filters(); render(); dialog.showModal();
  }
  function renderResult() {
    const results = jobs.filter(job => job.template === 'flux-compose');
    const signature = JSON.stringify([selectedId, results.map(j => [j.id, j.status, j.progress, j.error, j.outputs])]);
    if (signature === resultSignature) return; resultSignature = signature;
    q('#composer-result-choice').innerHTML = '<option value="">选择图片版本</option>' + results.map((job, index) => `<option value="${job.id}">${results.length - index} · ${status[job.status] || job.status} · ${new Date(job.createdAt).toLocaleString()}</option>`).join('');
    q('#composer-result-choice').value = selectedId;
    const job = results.find(j => j.id === selectedId), file = job?.outputs?.find(f => f.kind === 'image');
    const media = q('#composer-result-media');
    if (media.dataset.url !== (file?.url || '')) { media.innerHTML = file ? `<img src="${h(file.url)}" alt="当前选定版本的角色合成结果">` : '<p>选好参考、填写画面要求<br>候选图片将在这里出现</p>'; media.dataset.url = file?.url || ''; }
    q('#composer-result-state').textContent = job ? `${status[job.status] || job.status}${job.progress ? ` · ${job.progress.value} / ${job.progress.max}` : ''}${job.error ? '：' + job.error : active.has(job.status) ? ' · 模型加载阶段可能没有采样百分比，请等待。' : ''}` : selectedId ? '此版本已被删除，请选择其他版本。' : '尚未选定图片版本。';
    q('.composer-result-actions').hidden = !file;
    if (file) q('#composer-original').href = file.url;
  }
  panel.addEventListener('input', event => { if (!event.target.closest('.composer-result') && !event.target.closest('.composer-recipes')) updateForm(); });
  panel.addEventListener('change', event => {
    if (event.target.dataset.uploadRole && event.target.files[0]) { const file = event.target.files[0]; event.target.value = ''; void perform(() => upload(event.target.dataset.uploadRole, file)); }
    if (event.target.id === 'composer-project') void perform(async () => { refs = {}; shotChoices(); await loadSources(); updateForm(); });
    if (event.target.id === 'composer-result-choice') { selectedId = event.target.value; renderResult(); }
  });
  panel.addEventListener('dragover', event => { if (event.target.closest('[data-slot]')) event.preventDefault(); });
  panel.addEventListener('drop', event => { const card = event.target.closest('[data-slot]'); if (!card) return; event.preventDefault(); if (event.dataTransfer.files.length !== 1) { notice('每个参考槽一次只接收一张图片。', true); return; } void perform(() => upload(card.dataset.slot, event.dataTransfer.files[0])); });
  panel.addEventListener('paste', event => { const card = event.target.closest('[data-slot]'), file = [...(event.clipboardData?.items || [])].find(item => item.kind === 'file')?.getAsFile(); if (card && file) { event.preventDefault(); void perform(() => upload(card.dataset.slot, file)); } });
  panel.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.picker) void perform(() => picker(button.dataset.picker));
    else if (button.dataset.clearRole) { delete refs[button.dataset.clearRole]; updateForm(); }
    else if (button.hasAttribute('data-composer-copy')) void navigator.clipboard.writeText(q('#composer-prompt').textContent).then(() => notice('已复制当前提示词。'), () => notice('复制失败，可在提示词预览中手动选择复制。', true));
    else if (button.hasAttribute('data-save-recipe')) void perform(async () => { await post('/api/composer/recipes', { name: q('#composer-recipe-name').value, composition: composition() }); await reload(); notice('组合方案已保存，图片仍保留一份。'); });
    else if (button.hasAttribute('data-load-recipe')) void perform(async () => { const recipe = data.recipes.find(r => r.id === q('#composer-recipe').value); if (!recipe) throw Error('请选择组合方案。'); refs = Object.fromEntries(recipe.composition.references.map(r => [r.role, { ...r, url: '/api/uploads/' + r.uploadId }])); for (const field of ['description', 'mapping', 'style', 'size', 'seed']) q('#composer-' + field).value = recipe.composition[field] ?? ''; q('#composer-recipe-name').value = recipe.name; if (refs.outfit || refs.scene || refs.personB) q('.composer-more').open = true; updateForm(); notice(recipe.missing.length ? '方案中有参考已删除：' + recipe.missing.join('、') + '。请重新选择。' : '已载入组合方案，尚未提交生成。', !!recipe.missing.length); });
    else if (button.hasAttribute('data-delete-recipe')) void perform(async () => { const id = q('#composer-recipe').value; if (!id) throw Error('请选择要删除的组合方案。'); await api('/api/composer/recipes/' + id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } }); await reload(); notice('组合方案已删除，原图保留。'); });
    else if (button.id === 'composer-generate') void perform(async () => { const compositionValue = normalizeComposition(composition()); const job = await post('/api/composer/generate', { requestId: crypto.randomUUID(), composition: compositionValue, projectId: q('#composer-project').value || undefined, shotId: q('#composer-shot').value || undefined }); selectedId = job.id; await refreshJobs(); renderResult(); notice(job.status === 'failed' ? job.error : '角色合成任务已提交。', job.status === 'failed'); });
    else if (button.hasAttribute('data-adopt-frame')) void perform(async () => { const projectId = q('#composer-project').value, shotId = q('#composer-shot').value; if (!projectId || !shotId) throw Error('请先选择目标项目和镜头。'); const job = jobs.find(j => j.id === selectedId); if (job?.status !== 'success') throw Error('请选择已完成的图片版本。'); await post('/api/projects/' + projectId + '/frames/import', { jobId: selectedId, shotId }); await refreshJobs(); notice('所选版本已加入目标镜头首帧候选。请到项目中确认后生成视频。'); });
    else if (button.hasAttribute('data-save-character')) void perform(async () => { const projectId = q('#composer-project').value; if (!projectId) throw Error('请先选择项目。'); const name = q('#composer-role-name').value.trim(); if (!name) throw Error('请填写项目角色名称。'); await post('/api/catalog/' + projectId + '/import', { jobIds: [selectedId], category: 'character', name }); await refreshJobs(); await loadSources(); notice('已保存为当前项目的角色定稿，原图未重复复制。'); });
    else if (button.hasAttribute('data-open-target')) { const projectId = q('#composer-project').value; if (!projectId) { notice('请先选择目标项目。', true); return; } localStorage.setItem('aigc-project', projectId); openProject(); }
  });
  updateForm();
  return {
    async open(target) { opening = true; try { await reload(); initialized = true; if (target?.projectId) { if (q('#composer-project').value !== target.projectId) refs = {}; q('#composer-project').value = target.projectId; shotChoices(); if (target.shotId) q('#composer-shot').value = target.shotId; await loadSources(); } updateForm(); renderResult(); } finally { opening = false; } },
    update(value) { jobs = value.jobs; connected = value.connected; available = value.available; if (!initialized && !panel.hidden && !opening) void this.open().catch(e => notice(e.message, true)); updateForm(); renderResult(); }
  };
}
