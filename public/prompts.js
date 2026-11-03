import { adaptForH3 } from './video-options.js';
const h = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const names = { video: '视频描述片段', image: '图片描述片段', instruction: '文本模型模板', reference: '参考资料' };
let mounted = false;
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw Error(data.error); return data;
}
export function mountPromptLibrary(host, onApply, initialKind = '') {
  let current; let offset = 0; let timer; let generation = 0;
  host.innerHTML = `<div class="library-toolbar"><input class="library-search" aria-label="搜索提示词" placeholder="搜索标题、正文、运镜、题材…"><select class="library-kind" aria-label="提示词用途"><option value="">全部用途</option>${Object.entries(names).map(([id, name]) => `<option value="${id}">${name}</option>`).join('')}</select><select class="library-group" aria-label="提示词分类"><option value="">全部分类</option><option>02_视频与AI漫剧</option><option>01_绘图与图像编辑</option><option>我的提示词</option></select><label><input type="checkbox" class="library-favorites">仅收藏</label><button class="project-button library-refresh">重新扫描资料</button></div><p class="library-status field-help" role="status"></p><details class="library-issues" hidden><summary>查看读取问题</summary><div></div></details><div class="library-layout"><div><div class="library-list"></div><div class="library-pagination"><button class="project-button previous">上一页</button><span class="page-number"></span><button class="project-button next">下一页</button></div></div><div class="library-detail"><p class="field-help">选择左侧条目，查看原文、来源并套用。</p></div></div><details class="custom-prompt"><summary>保存我的提示词</summary><div class="custom-fields"><input class="custom-title" aria-label="自定义提示词标题" placeholder="标题"><select class="custom-kind" aria-label="自定义提示词类别"><option value="video">视频描述片段</option><option value="image">图片描述片段</option><option value="instruction">文本模型模板</option></select></div><textarea class="custom-body" rows="4" maxlength="30000" placeholder="填写自己的提示词…"></textarea><button class="project-button custom-save">保存到我的提示词</button></details>`;
  const $ = selector => host.querySelector(selector);
  $('.library-kind').value = initialKind;
  const message = text => { $('.library-status').textContent = text; };
  async function search(reset = false) {
    if (reset) offset = 0;
    const ticket = ++generation;
    const query = new URLSearchParams({ search: $('.library-search').value, kind: $('.library-kind').value, group: $('.library-group').value, favorites: $('.library-favorites').checked ? '1' : '0', offset });
    const data = await api('/api/prompts?' + query);
    if (ticket !== generation) return;
    message(`${data.sourceCount} 份资料 · ${data.allCount} 个条目 · 匹配 ${data.total} 个。${data.issues.length ? `有 ${data.issues.length} 份资料未完整读取，可查看源文件。` : ''}${data.refresh.status === 'running' ? ' 正在重新扫描，完成后再次搜索即可更新。' : ''}`);
    $('.library-issues').hidden = !data.issues.length;
    $('.library-issues div').innerHTML = data.issues.map(item => `<p class="field-help">${h(item.source)}：${h(item.reason)}</p>`).join('');
    if (data.refresh.status === 'failed') message('重新扫描失败：' + data.refresh.error);
    $('.library-list').innerHTML = data.items.map(item => `<button class="library-item ${current?.id === item.id ? 'selected' : ''}" data-id="${item.id}"><strong>${h(item.title)}</strong><small>${names[item.kind]} · ${h(item.sourceModel)} ${item.favorite ? '★' : ''}</small><span>${h(item.preview)}</span></button>`).join('') || '<div class="empty-library">没有匹配条目，试试其他关键词或用途。</div>';
    $('.previous').disabled = offset === 0; $('.next').disabled = offset + 40 >= data.total;
    $('.page-number').textContent = `${Math.floor(offset / 40) + 1} / ${Math.max(1, Math.ceil(data.total / 40))}`;
  }
  function variables() {
    const body = $('.prompt-editor').value;
    const keys = [...new Set([...body.matchAll(/\{\{([^{}\n]{1,50})\}\}|\[([^\[\]\n]{1,50})\]/g)].map(match => match[1] || match[2]))].slice(0, 16);
    $('.prompt-variables').innerHTML = keys.map((key, i) => `<label>${h(key)}<input data-variable="${i}" data-key="${h(key)}" placeholder="填写后点击替换变量"></label>`).join('');
  }
  async function select(id) {
    current = await api('/api/prompts/' + id);
    $('.library-detail').innerHTML = `<h2>${h(current.title)}</h2><p class="field-help">${names[current.kind]} · 原适用模型：${h(current.sourceModel)}</p><p class="prompt-source">来源：${h(current.source)}<br>${h(current.location)}</p>${current.kind === 'instruction' ? '<div class="notice compact">这是给文本模型的指令模板，供复制或手动改写。可在镜头项目使用本地文字助手整理草稿，不能将整段模板直接作为视频画面描述。</div>' : current.kind === 'reference' ? '<p class="field-help">这是参考资料，请摘取并改写需要的描述。</p>' : '<p class="field-help">原文适用于其他模型时，可先适配 H3，再检查与补齐主体、动作和镜头描述。</p>'}<div class="prompt-variables"></div><div class="prompt-edit-actions"><button class="project-button replace-vars">替换变量</button><button class="project-button adapt-h3" ${['video', 'image'].includes(current.kind) ? '' : 'hidden'}>去除模型专属措辞</button><button class="project-button restore-source">恢复原文</button></div><textarea class="prompt-editor" rows="15" aria-label="提示词原文与编辑区"></textarea><div class="prompt-edit-actions"><button class="project-button copy-prompt">复制正文</button><button class="project-button favorite-prompt">${current.favorite ? '取消收藏' : '收藏 ★'}</button>${current.source !== '我的提示词' ? `<a class="project-button" href="/api/prompts/${current.id}/source" download>保存源文件</a>` : ''}<button class="project-button accent apply-prompt" ${onApply && ['video', 'image'].includes(current.kind) ? '' : 'hidden'}>套用到当前描述 ↗</button></div>`;
    $('.prompt-editor').value = current.body;
    $('.prompt-edit-actions').insertAdjacentHTML('beforeend','<button class="project-button translate-prompt">中文翻译（选中段落优先）</button>');
    $('.library-detail').insertAdjacentHTML('beforeend','<details class="prompt-translation" hidden open><summary>中文译文（原文保留）</summary><textarea class="translation-result" rows="8" readonly></textarea><button class="project-button use-translation">使用中文译文编辑</button></details>');
    variables();
    host.querySelectorAll('.library-item').forEach(item => item.classList.toggle('selected', item.dataset.id === id));
  }
  $('.library-search').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => search(true).catch(error => message(error.message)), 250); });
  for (const selector of ['.library-kind', '.library-group', '.library-favorites']) $(selector).addEventListener('change', () => search(true).catch(error => message(error.message)));
  host.addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button) return;
    try {
      if (button.dataset.id) await select(button.dataset.id);
      else if (button.matches('.previous')) { offset = Math.max(0, offset - 40); await search(); }
      else if (button.matches('.next')) { offset += 40; await search(); }
      else if (button.matches('.library-refresh')) { const result = await api('/api/prompts/refresh', {}); message(result.status === 'running' ? '正在重新扫描原资料，现有条目仍可使用。稍后搜索即可加载更新。' : '扫描请求已提交。'); }
      else if (button.matches('.favorite-prompt')) { const result = await api('/api/prompts/favorite', { id: current.id, favorite: !current.favorite }); current.favorite = result.favorite; button.textContent = current.favorite ? '取消收藏' : '收藏 ★'; }
      else if (button.matches('.copy-prompt')) { await navigator.clipboard.writeText($('.prompt-editor').value); message('正文已复制。'); }
      else if(button.matches('.translate-prompt')){const editor=$('.prompt-editor');const text=editor.selectionEnd>editor.selectionStart?editor.value.slice(editor.selectionStart,editor.selectionEnd):editor.value;if(text.length>6000)throw Error('内容超过 6000 字，请先选中需要翻译的段落。');button.disabled=true;message('本机文字模型正在翻译，原文会保留…');try{const result=await api('/api/assistant/suggest',{kind:'translate',text,sourceId:current.id});$('.translation-result').value=result.content.translation;$('.prompt-translation').hidden=false;message('中文译文已就绪，请核对后决定是否使用。');}finally{button.disabled=false;}}
      else if(button.matches('.use-translation')){$('.prompt-editor').value=$('.translation-result').value;variables();message('已将中文译文放入编辑区，源文件与原条目保持不变。');}
      else if (button.matches('.adapt-h3')) { $('.prompt-editor').value = adaptForH3($('.prompt-editor').value); message('已去除模型名称和部分专属措辞，请检查正文；这不保证模型能复现全部效果。'); }
      else if (button.matches('.restore-source')) { $('.prompt-editor').value = current.body; variables(); }
      else if (button.matches('.replace-vars')) {
        let body = $('.prompt-editor').value;
        host.querySelectorAll('[data-variable]').forEach(input => { if (input.value.trim()) body = body.split('{{' + input.dataset.key + '}}').join(input.value.trim()).split('[' + input.dataset.key + ']').join(input.value.trim()); });
        $('.prompt-editor').value = body;
      } else if (button.matches('.apply-prompt') && onApply) {
        if (!['video', 'image'].includes(current.kind)) throw Error('请先手动改写成画面描述。');
        const body = $('.prompt-editor').value.trim();
        if (!body || body.length > 6000) throw Error('套用的描述应为 1～6000 字，请先精简。');
        onApply(body, current);
      } else if (button.matches('.custom-save')) {
        await api('/api/prompts/custom', { title: $('.custom-title').value, kind: $('.custom-kind').value, body: $('.custom-body').value });
        $('.custom-title').value = ''; $('.custom-body').value = ''; $('.library-group').value = '我的提示词'; $('.library-kind').value = ''; await search(true);
      }
    } catch (error) { message(error.message); }
  });
  void search().catch(error => message(error.message));
}
export function showPromptPicker({ kind = '', onApply }) {
  let dialog = document.querySelector('#prompt-picker');
  if (!dialog) { dialog = document.createElement('dialog'); dialog.id = 'prompt-picker'; document.body.append(dialog); }
  dialog.innerHTML = '<div class="dialog-heading"><h2>从已有提示词库选择</h2><button class="close-picker" aria-label="关闭提示词库">×</button></div><div class="prompt-picker-content"></div>';
  dialog.querySelector('.close-picker').onclick = () => dialog.close();
  mountPromptLibrary(dialog.querySelector('.prompt-picker-content'), (body, item) => { onApply(body, item); dialog.close(); }, kind);
  dialog.showModal();
}
export function openPromptPage() {
  if (!mounted) { mounted = true; mountPromptLibrary(document.querySelector('#prompts-panel')); }
}
