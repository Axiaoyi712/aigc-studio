const h=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let host,projects=[],records=[],projectId='',busy=false,created=null,loaded=false;
const $=selector=>host.querySelector(selector);
const selected=()=>records.find(r=>r.id===$('#driver-select').value);
async function api(path,body){
 const response=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const data=await response.json();if(!response.ok)throw Error(data.error||'请求失败，请重试。');return data;
}
function message(text='',error=false){const node=$('#driver-message');node.hidden=!text;node.textContent=text;node.className='driver-message'+(error?' is-error':'');}
function resetCreated(){created=null;$('#driver-success').hidden=true;}
function mount(){
 host=document.querySelector('#driver-studio');
 host.innerHTML=`<ol class="driver-steps" aria-label="白膜视频制作流程"><li><b>1</b><span>导入白膜视频<small>选择动作来源</small></span></li><li><b>2</b><span>设置片段与画质<small>先试一个短镜头</small></span></li><li><b>3</b><span>创建镜头，继续生成<small>人物与场景在下一步设置</small></span></li></ol>
 <div class="driver-project-bar"><label for="driver-project">保存到项目<select id="driver-project"><option value="">正在读取项目…</option></select></label><button type="button" class="driver-button" id="driver-new-toggle" aria-expanded="false" aria-controls="driver-new-form">＋ 新建项目</button><div id="driver-new-form" class="driver-new-form" hidden><label for="driver-project-name">项目名称<input id="driver-project-name" maxlength="80" placeholder="例如：餐厅对话短剧"></label><button type="button" class="driver-button" id="driver-new">创建项目</button></div></div>
 <p id="driver-message" class="driver-message" role="status" aria-live="polite" hidden></p>
 <div class="driver-layout"><div class="driver-settings">
 <section class="driver-card"><div class="driver-card-heading"><span class="driver-step-number">01</span><div><h2>导入白膜视频</h2><p>选择一种导入方式即可。</p></div></div>
 <div class="driver-import-tabs" role="group" aria-label="视频导入方式"><button type="button" data-driver-import="path" aria-pressed="true">关联本地路径 <small>不复制原片</small></button><button type="button" data-driver-import="file" aria-pressed="false">选择文件 <small>导入到项目</small></button></div>
 <div data-driver-source="path"><label for="driver-path">视频完整路径</label><div class="driver-source-row"><input id="driver-path" placeholder="粘贴从资源管理器复制的视频地址"><button type="button" class="driver-button" id="driver-link">读取视频</button></div><p class="driver-help">可使用任意文件夹中的视频。关联后请保留原文件位置。</p></div>
 <div data-driver-source="file" hidden><label for="driver-upload-file">选择本机视频</label><div class="driver-source-row"><input type="file" id="driver-upload-file" accept=".mp4,.mov,.mkv,.webm,.avi"><button type="button" class="driver-button" id="driver-upload">导入视频</button></div><p class="driver-help">会在本项目中保存一份视频，最大1GB。</p></div>
 <div class="driver-existing" hidden><label for="driver-select">此项目已导入的视频</label><select id="driver-select"><option value="">尚未导入视频</option></select></div></section>
 <section class="driver-card"><div class="driver-card-heading"><span class="driver-step-number">02</span><div><h2>片段与画质</h2><p>建议先用约3秒的片段，检查动作效果。</p></div></div>
 <fieldset class="driver-choice-group"><legend>生成范围</legend><div class="driver-range-choices"><label><input type="radio" name="driver-range" value="clip" checked><span>选取一个片段</span></label><label><input type="radio" name="driver-range" value="full"><span>整段自动拆分</span></label></div></fieldset>
 <div class="driver-time-grid" id="driver-times"><label for="driver-start">开始时间 <small>秒</small><input id="driver-start" type="number" step="0.01" min="0" value="0"></label><label for="driver-end">结束时间 <small>秒</small><input id="driver-end" type="number" step="0.01" min="0" value="3"></label></div><p id="driver-range-help" class="driver-help">单个片段最长5.17秒。</p>
 <fieldset class="driver-choice-group"><legend>画质档位 <span>正式结果至少720p</span></legend><div class="driver-quality-choices"><label class="driver-quality-card"><input type="radio" name="driver-quality" value="native720" checked><span><strong>原生高清</strong><small>直接以高清尺寸生成，画质优先，耗时较长。</small></span></label><label class="driver-quality-card"><input type="radio" name="driver-quality" value="preview"><span><strong>快速生成＋AI精修</strong><small>先用较小尺寸生成，再精修至720p，适合试做。</small></span></label></div></fieldset></section>
 <div class="driver-action-bar"><div><strong id="driver-create-summary">请先导入视频</strong><p>本步只准备镜头；下一步选择人物、场景并生成。</p></div><button type="button" class="driver-button driver-primary" id="driver-create" disabled>创建镜头 →</button></div>
 <section class="driver-success" id="driver-success" role="status" hidden><span class="driver-step-number">03</span><div><h2 id="driver-success-title">镜头已准备好</h2><p>先设置人物与场景参考，再编辑提示词、生成并确认首帧，最后生成视频。</p><div class="driver-success-actions"><button type="button" class="driver-button driver-primary" data-driver-continue="2">继续：设置人物与场景 →</button><button type="button" class="driver-button" data-driver-continue="3">已有参考，去编辑镜头</button></div></div></section></div>
 <aside class="driver-preview-column"><section class="driver-card driver-preview-card"><div class="driver-preview-heading"><h2>视频预览</h2><span id="driver-source-tag">等待导入</span></div><div class="driver-preview-media"><div id="driver-preview-empty"><span aria-hidden="true">▷</span><strong>先导入一段白膜视频</strong><p>视频画面、时长与尺寸会显示在这里。</p></div><video id="driver-preview" controls playsinline preload="metadata" hidden></video></div><p id="driver-source-name" class="driver-source-name" hidden></p><div id="driver-info" class="driver-metadata" hidden></div></section>
 <details class="driver-notes"><summary>素材要求与保存说明</summary><p>这里使用已处理好的白膜／深度视频，普通彩色视频不会自动转换为深度图。优先使用没有叠字、水印的素材。</p><p>人物身份与服装由参考图片和确认的首帧控制；深度视频负责动作与空间。复杂手指、嘴型和遮挡仍需逐镜检查。</p><p>镜头和成片保存到所选项目。关联路径不复制原片；处理时只生成所需的短片段缓存。</p></details></aside></div>`;
 host.addEventListener('click',onClick);host.addEventListener('change',onChange);host.addEventListener('input',event=>{if(['driver-start','driver-end'].includes(event.target.id)){resetCreated();update();}});
 $('#driver-preview').addEventListener('error',()=>{if(selected()){$('#driver-source-tag').textContent='预览不可用';message('浏览器无法预览此视频；可尝试MP4格式，或按有效时间范围创建镜头。',true);}});
}
export async function openDriverStudio(){
 if(!host)mount();if(busy)return;
 await perform(async()=>{
  projects=await api('/api/projects');
  const previous=projectId;
  const preferred=projectId||localStorage.getItem('aigc-driver-project')||localStorage.getItem('aigc-project');
  projectId=projects.some(p=>p.id===preferred)?preferred:projects[0]?.id||'';
  renderProjects();if(!loaded||previous!==projectId)await loadVideos();loaded=true;
 },'正在读取项目…');
}
function renderProjects(){
 $('#driver-project').innerHTML='<option value="">选择项目</option>'+projects.map(p=>`<option value="${h(p.id)}">${h(p.name)}</option>`).join('');$('#driver-project').value=projectId;
 if(!projects.length){$('#driver-new-form').hidden=false;$('#driver-new-toggle').setAttribute('aria-expanded','true');}
}
async function loadVideos(preferred){
 resetCreated();records=projectId?await api(`/api/projects/${projectId}/drivers`):[];
 $('#driver-select').innerHTML='<option value="">选择视频</option>'+records.map(r=>`<option value="${h(r.id)}">${h(r.name)}</option>`).join('');
 $('#driver-select').value=records.some(r=>r.id===preferred)?preferred:records.at(-1)?.id||'';showSource();
}
function showSource(){
 resetCreated();const r=selected(),v=$('#driver-preview');
 $('.driver-existing').hidden=records.length<2;$('#driver-preview-empty').hidden=!!r;v.hidden=!r;
 $('#driver-source-name').hidden=!r;$('#driver-info').hidden=!r;v.pause();
 if(r){
  v.src=`/api/projects/${r.projectId}/drivers/${r.id}/file`;$('#driver-source-name').textContent=r.name;$('#driver-source-name').title=r.name;
  $('#driver-source-tag').textContent=r.imported?'已导入项目':'已关联原片';$('#driver-start').value='0';$('#driver-end').value=(Math.floor(Math.min(3,r.metadata.duration)*100+1e-8)/100).toFixed(2);
  $('#driver-info').innerHTML=[`${r.metadata.width} × ${r.metadata.height}`,`${r.metadata.duration.toFixed(2)} 秒`,`${r.metadata.fps.toFixed(2)} fps`].map(v=>`<span>${h(v)}</span>`).join('');
 }else{v.removeAttribute('src');v.load();$('#driver-source-tag').textContent='等待导入';}
 update();
}
function selection(){
 const r=selected(),split=$('[name="driver-range"]:checked').value==='full',start=split?0:Number($('#driver-start').value),end=split?r?.metadata.duration:Number($('#driver-end').value);
 const valid=!!r&&Number.isFinite(start)&&Number.isFinite(end)&&start>=0&&end>start&&end<=r.metadata.duration+.001&&(split||end-start<=5.17);
 return {r,split,start,end,valid,count:valid?(split?Math.ceil((end-start)/3):1):0,quality:$('[name="driver-quality"]:checked').value};
}
function update(){
 const s=selection();$('#driver-times').hidden=s.split;
 $('#driver-range-help').textContent=s.split?(s.r?`完整覆盖 ${s.r.metadata.duration.toFixed(2)} 秒，按约3秒拆分，最后一段保留剩余时长。`:'导入后会按约3秒自动拆分整段视频。'):'单个片段最长5.17秒，建议先试约3秒。';
 $('#driver-create-summary').textContent=!projectId?'先选择或新建一个项目':!s.r?'请先导入视频':s.valid?`将创建 ${s.count} 个镜头 · ${s.split?s.r.metadata.duration.toFixed(2):(s.end-s.start).toFixed(2)} 秒`:'请检查起止时间：片段须在视频内，且不超过5.17秒';
 $('#driver-create').textContent=busy?'正在准备…':created?'镜头已创建':s.valid?`创建 ${s.count} 个镜头 →`:'创建镜头 →';
 for(const node of host.querySelectorAll('input,select,button'))node.disabled=busy;
 $('#driver-link').disabled=busy||!projectId;$('#driver-upload').disabled=busy||!projectId;$('#driver-create').disabled=busy||!projectId||!s.valid||!!created;
 host.setAttribute('aria-busy',String(busy));
}
async function perform(action,status){
 if(busy)return;busy=true;message(status);update();
 try{await action();message();}catch(error){message(error.message,true);}finally{busy=false;update();}
}
async function onClick(event){
 const button=event.target.closest('button');if(!button||button.disabled)return;
 if(button.dataset.driverImport){for(const b of host.querySelectorAll('[data-driver-import]'))b.setAttribute('aria-pressed',String(b===button));for(const pane of host.querySelectorAll('[data-driver-source]'))pane.hidden=pane.dataset.driverSource!==button.dataset.driverImport;return;}
 if(button.id==='driver-new-toggle'){const form=$('#driver-new-form');form.hidden=!form.hidden;button.setAttribute('aria-expanded',String(!form.hidden));if(!form.hidden)$('#driver-project-name').focus();return;}
 if(button.dataset.driverContinue){if(created)window.dispatchEvent(new CustomEvent('aigc-open-project',{detail:{projectId:created.projectId,step:Number(button.dataset.driverContinue)}}));return;}
 if(!['driver-new','driver-link','driver-upload','driver-create'].includes(button.id))return;
 await perform(async()=>{
  if(button.id==='driver-new'){
   const name=$('#driver-project-name').value.trim();if(!name)throw Error('请先填写项目名称。');
   const p=await api('/api/projects',{name,production:{}});projects.push(p);projectId=p.id;localStorage.setItem('aigc-driver-project',projectId);renderProjects();$('#driver-new-form').hidden=true;$('#driver-new-toggle').setAttribute('aria-expanded','false');await loadVideos();return;
  }
  if(!projectId)throw Error('请先选择或新建一个项目。');const base=`/api/projects/${projectId}/drivers`;
  if(button.id==='driver-link'){
   const path=$('#driver-path').value.trim();if(!path)throw Error('请先粘贴视频的完整路径。');const r=await api(base,{path});await loadVideos(r.id);
  }else if(button.id==='driver-upload'){
   const f=$('#driver-upload-file').files[0];if(!f)throw Error('请先选择视频文件。');if(f.size>1024**3)throw Error('视频超过1GB，请改用关联本地路径。');
   const response=await fetch(base,{method:'POST',headers:{'Content-Type':f.type||'application/octet-stream','X-File-Name':encodeURIComponent(f.name)},body:f});const data=await response.json();if(!response.ok)throw Error(data.error);await loadVideos(data.id);
  }else{
   const s=selection();if(!s.valid)throw Error('请检查视频和片段时间。');const result=await api(base+`/${s.r.id}/clips`,{start:s.start,end:s.end,split:s.split,quality:s.quality});
   created={projectId,count:result.shots.length};$('#driver-success-title').textContent=`${created.count} 个镜头已保存到“${projects.find(p=>p.id===projectId)?.name||'当前项目'}”`;$('#driver-success').hidden=false;$('#driver-success').scrollIntoView({behavior:'smooth',block:'nearest'});
  }
 },button.id==='driver-create'?'正在准备片段并保存镜头，请稍候…':button.id==='driver-new'?'正在创建项目…':'正在读取视频信息…');
}
async function onChange(event){
 if(event.target.id==='driver-project'){
  projectId=event.target.value;localStorage.setItem('aigc-driver-project',projectId);await perform(()=>loadVideos(),'正在读取项目素材…');
 }else if(event.target.id==='driver-select'){message();showSource();}
 else if(event.target.matches('[name="driver-range"],[name="driver-quality"]')){resetCreated();update();}
}
