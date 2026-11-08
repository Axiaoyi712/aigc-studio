import { normalizeVideoOptions, videoCanvas, videoResolutionLabel } from './video-options.js';

const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const imageTypes = /\.(png|jpe?g|webp)$/i;
const sourceNames = { job: '已有作品', asset: '项目素材', file: '镜头文件夹' };

export async function openFrameImport(ctx) {
  if (document.querySelector('.frame-import-dialog')) return;
  const { project, shot, api } = ctx;
  const dialog = document.createElement('dialog');
  dialog.className = 'frame-import-dialog';
  dialog.setAttribute('aria-labelledby', 'frame-import-title');
  dialog.innerHTML = `<div class="dialog-heading"><div><h2 id="frame-import-title">导入／选用首帧</h2><p>${h(shot.title)} · 加入候选后，再确认使用</p></div><button type="button" data-frame-close aria-label="关闭">×</button></div>
    <div class="frame-import-tabs" role="tablist" aria-label="图片来源"><button type="button" role="tab" data-frame-tab="local" aria-selected="true">本地图片</button><button type="button" role="tab" data-frame-tab="existing" aria-selected="false">已有作品／项目素材</button></div>
    <section data-frame-panel="local"><div class="frame-local-actions"><button type="button" class="project-button" data-frame-native>选择本地图片</button><label class="project-button frame-browser-button">浏览器选图<input type="file" accept="image/png,image/jpeg,image/webp" data-frame-file></label></div><div class="frame-import-drop" tabindex="0" role="button" aria-label="拖入一张图片，或按回车浏览图片">也可将一张图片拖到这里<span>PNG、JPG、WEBP · 最大 20MB</span></div><p class="frame-import-file" data-frame-file-name>尚未选择图片</p><fieldset class="frame-storage"><legend>保存方式</legend><label><input type="radio" name="frame-storage" value="copy" checked>复制到项目<span>保留外部原图；项目内只保存一份</span></label><label><input type="radio" name="frame-storage" value="move">移动到项目<span>导入成功后，移除原位置的图片</span></label></fieldset><p class="field-help" data-frame-storage-help>本地选择支持复制或移动；浏览器选图和拖入图片会保留外部原图。</p></section>
    <section data-frame-panel="existing" hidden><div class="frame-source-tools"><label>搜索图片<input type="search" data-frame-search placeholder="按图片名称搜索"></label><button type="button" class="project-button" data-frame-refresh>刷新列表</button></div><p class="field-help">复用已有原文件，不重复保存。这里只显示本项目素材、镜头图片和可选用的已有作品。</p><div class="frame-source-grid" data-frame-sources></div></section>
    <section class="frame-import-preview" hidden><div class="frame-preview-title"><h3>导入前检查</h3><span data-frame-dimensions>正在读取图片尺寸…</span></div><div class="frame-preview-grid"><figure><figcaption>原始图片</figcaption><div class="frame-original"><img data-frame-original alt="所选原始图片"></div></figure><figure><figcaption>模型实际取景预览</figcaption><div class="frame-crop-stage"><div class="frame-crop"><img data-frame-crop alt="视频生成时的居中取景预览"></div></div></figure></div><p class="field-help" data-frame-canvas></p><p class="field-help">固定画幅按中心裁切；此预览用于核对人物和构图，原始图片保持原样。视频模型可能仍会改变画面细节。</p></section>
    <p class="notice error" data-frame-message role="alert" hidden></p><div class="frame-import-footer"><p data-frame-status>只加入首帧候选，保留已有首帧和视频版本。</p><button type="button" class="project-button accent" data-frame-submit disabled>加入候选首帧</button></div>`;
  document.body.append(dialog);
  dialog.showModal();
  const $ = selector => dialog.querySelector(selector);
  let selected, sources = [], pending = false, tab = 'local', objectUrl, selectionVersion = 0;
  let sourcesLoaded = false;
  const message = text => { $('[data-frame-message]').textContent = text; $('[data-frame-message]').hidden = !text; };
  const controls = () => {
    const locked = pending || ctx.isBusy();
    $('[data-frame-submit]').disabled = locked || !selected?.width || !selected?.height;
    $('[data-frame-submit]').textContent = pending ? '正在导入…' : '加入候选首帧';
    for (const el of dialog.querySelectorAll('[data-frame-native],[data-frame-file],[data-frame-refresh],.frame-storage input')) el.disabled = locked || (el.value === 'move' && selected?.kind !== 'native');
    for (const el of dialog.querySelectorAll('[data-frame-source]')) el.disabled = pending;
    $('[data-frame-close]').disabled = pending;
    $('[data-frame-status]').textContent = locked && !pending ? '生成任务进行中，可以预览图片；队列结束后可加入候选。' : '只加入首帧候选，保留已有首帧和视频版本。';
  };
  function preview() {
    $('.frame-import-preview').hidden = false;
    const video = normalizeVideoOptions({ ...project.video, ...(shot.frames ? { frames: shot.frames } : {}) });
    const canvas = videoCanvas(video);
    const [width, height] = video.aspect === 'source' ? [selected.width, selected.height] : canvas[video.aspect];
    $('.frame-crop').style.aspectRatio = width + ' / ' + height;
    $('.frame-crop').style.maxWidth = width / height < 1 ? Math.round($('.frame-crop-stage').clientHeight * width / height) + 'px' : '100%';
    $('[data-frame-dimensions]').textContent = `${selected.width} × ${selected.height} 原始像素`;
    $('[data-frame-canvas]').textContent = video.aspect === 'source'
      ? `项目视频画幅：跟随首帧（${selected.width}:${selected.height}）。${videoResolutionLabel(video)}，生成尺寸会按像素档位缩放并对齐模型要求；保留完整构图。`
      : `项目视频画幅：${{ square: '方形', portrait: '竖版', landscape: '横版' }[video.aspect]}，模型输入 ${width} × ${height}。预览展示实际画幅的居中裁切范围。`;
    for (const image of dialog.querySelectorAll('[data-frame-original],[data-frame-crop]')) image.src = selected.url;
    controls();
  }
  async function select(value) {
    const version = ++selectionVersion;
    message(''); selected = { ...value, width: 0, height: 0 };
    $('.frame-import-preview').hidden = true;
    $('[data-frame-file-name]').textContent = value.name;
    if (value.kind !== 'native') $('input[name="frame-storage"][value="copy"]').checked = true;
    $('[data-frame-storage-help]').textContent = value.kind === 'native'
      ? '移动会移除原位置的文件；需要继续在其他软件使用原图时，请选择复制。'
      : value.kind === 'upload' ? '浏览器选图或拖拽只复制到项目；外部原图保留，不会自动删除。' : '复用已有原文件，不创建第二份图片；删除该原文件会同步清理有关引用。';
    controls();
    if (!value.url) { message('无法预览此图片，请改用“浏览器选图”。'); return; }
    const probe = new Image();
    probe.onload = () => {
      if (version !== selectionVersion || !dialog.isConnected) return;
      selected.width = probe.naturalWidth; selected.height = probe.naturalHeight; preview();
    };
    probe.onerror = () => { if (version === selectionVersion) { selected.width = selected.height = 0; message('图片已无法读取，请刷新列表或重新选择。'); controls(); } };
    probe.src = value.url;
  }
  async function selectFile(file) {
    if (pending) return;
    if (!file) return;
    if (!imageTypes.test(file.name) || !['image/png', 'image/jpeg', 'image/webp', ''].includes(file.type)) { message('请选择 PNG、JPG 或 WEBP 图片。'); return; }
    if (file.size > 20 * 1024 * 1024) { message('首帧图片上限为 20MB。'); return; }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    await select({ kind: 'upload', file, name: file.name, url: objectUrl });
  }
  function renderSources() {
    const query = $('[data-frame-search]').value.trim().toLowerCase();
    const shown = sources.filter(item => String(item.name).toLowerCase().includes(query));
    $('[data-frame-sources]').innerHTML = shown.map(item => `<button type="button" class="frame-source-item" data-frame-source="${h(item.id)}" aria-pressed="${selected?.source?.id === item.id}"><img src="${h(item.url)}" loading="lazy" alt=""><strong>${h(item.name)}</strong><small>${sourceNames[item.type] || '已有图片'}${item.width && item.height ? ` · ${item.width}×${item.height}` : ''}</small></button>`).join('') || '<p class="frame-source-empty">没有匹配的图片，可使用本地图片。</p>';
  }
  async function loadSources() {
    $('[data-frame-sources]').textContent = '正在读取图片列表…';
    try { sources = await api(`/api/projects/${project.id}/frames/sources`); sourcesLoaded = true; renderSources(); }
    catch (error) { message(error.message); $('[data-frame-sources]').textContent = '读取失败，请刷新重试。'; }
  }
  function switchTab(next) {
    tab = next;
    for (const button of dialog.querySelectorAll('[data-frame-tab]')) button.setAttribute('aria-selected', String(button.dataset.frameTab === tab));
    for (const section of dialog.querySelectorAll('[data-frame-panel]')) section.hidden = section.dataset.framePanel !== tab;
    if (tab === 'existing' && !sourcesLoaded) void loadSources();
  }
  dialog.addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.hasAttribute('data-frame-close')) return dialog.close();
    if (button.dataset.frameTab) return switchTab(button.dataset.frameTab);
    if (button.hasAttribute('data-frame-refresh')) return void loadSources();
    if (button.hasAttribute('data-frame-native')) {
      if (ctx.isBusy() || pending) return;
      pending = true; controls();
      try {
        const picked = await api('/api/frames/pick', {});
        if (!picked.cancelled) await select({ ...picked, kind: 'native', name: picked.name || picked.path.split(/[\\/]/).pop(), url: picked.url || picked.previewUrl || picked.dataUrl });
      } catch (error) { message(error.message); }
      finally { pending = false; controls(); }
      return;
    }
    if (button.dataset.frameSource) {
      if (pending) return;
      const source = sources.find(item => item.id === button.dataset.frameSource);
      if (source) { await select({ ...source, source, kind: 'existing' }); renderSources(); }
      return;
    }
    if (!button.hasAttribute('data-frame-submit') || !selected?.width || ctx.isBusy() || pending) return;
    pending = true; controls(); message('');
    await ctx.perform(async () => {
      try {
        await ctx.save();
        const body = { shotId: shot.id };
        if (selected.kind === 'native') Object.assign(body, { localPath: selected.path, mode: $('input[name="frame-storage"]:checked').value });
        else if (selected.kind === 'upload') {
          const response = await fetch('/api/uploads', { method: 'POST', headers: { 'Content-Type': selected.file.type || 'application/octet-stream' }, body: selected.file });
          const uploaded = await response.json();
          if (!response.ok) throw Error(uploaded.error || '图片上传失败。');
          Object.assign(body, { uploadId: uploaded.id, mode: 'copy', name: selected.name });
        } else {
          const source = selected.source;
          body[{ job: 'jobId', asset: 'assetId', file: 'relativePath' }[source.type]] = source.type === 'file' ? source.relativePath || source.id : source.id;
        }
        await api(`/api/projects/${project.id}/frames/import`, body);
        await ctx.reload(true);
        ctx.notice('图片已加入候选首帧。核对后点击“确认所选首帧”，再生成视频。');
        pending = false; dialog.close();
      } catch (error) { message(error.message); }
    });
    pending = false; controls();
  });
  $('[data-frame-file]').addEventListener('change', event => void selectFile(event.target.files[0]));
  $('[data-frame-search]').addEventListener('input', renderSources);
  const drop = $('.frame-import-drop');
  drop.addEventListener('click', () => $('[data-frame-file]').click());
  drop.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); $('[data-frame-file]').click(); } });
  drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', event => { event.preventDefault(); drop.classList.remove('drag-over'); if (event.dataTransfer.files.length !== 1) message('一次请选择一张首帧图片。'); else void selectFile(event.dataTransfer.files[0]); });
  dialog.addEventListener('cancel', event => { if (pending) event.preventDefault(); });
  const resize = new ResizeObserver(() => { if (selected?.width && selected?.height) preview(); });
  resize.observe($('.frame-crop-stage'));
  const timer = setInterval(controls, 1000);
  dialog.addEventListener('close', () => { clearInterval(timer); resize.disconnect(); selectionVersion++; if (objectUrl) URL.revokeObjectURL(objectUrl); dialog.remove(); }, { once: true });
  controls();
  if (ctx.file) await selectFile(ctx.file);
}
